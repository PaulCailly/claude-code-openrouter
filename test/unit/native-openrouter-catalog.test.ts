import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CatalogError,
  catalogFile,
  loadCatalog,
  parseCatalog,
} from '../../src/openrouter/catalog.ts';

const fixture: unknown = JSON.parse(
  await readFile(new URL('../fixtures/models.json', import.meta.url), 'utf8'),
);
const unix = { env: {}, platform: 'linux' as const };
const offline = async () => {
  throw new Error('offline');
};

async function home() {
  return mkdtemp(path.join(os.tmpdir(), 'openrouter-catalog-'));
}

test('parseCatalog admits only tool-capable models', () => {
  const ids = parseCatalog(fixture).map((model) => model.id);
  assert(!ids.includes('meta/no-tools-model'));
  assert(ids.includes('anthropic/claude-sonnet-4.5'));
  assert.equal(ids.length, 5);
});

test('parseCatalog reads capabilities from the payload, never from the id', () => {
  const models = parseCatalog(fixture);
  const sonnet = models.find((model) => model.id === 'anthropic/claude-sonnet-4.5');
  assert.deepEqual(
    { images: sonnet?.images, reasoning: sonnet?.reasoning, max: sonnet?.maxOutputTokens },
    { images: true, reasoning: true, max: 64000 },
  );
  const plain = models.find((model) => model.id === 'x/plain-tools');
  assert.deepEqual(
    { images: plain?.images, reasoning: plain?.reasoning },
    {
      images: false,
      reasoning: false,
    },
  );
});

test('parseCatalog falls back to the context length when max_completion_tokens is null', () => {
  const model = parseCatalog(fixture).find((entry) => entry.id === 'x/no-max-model');
  assert.equal(model?.maxOutputTokens, 32768);
  assert.equal(model?.contextLength, 32768);
});

test('parseCatalog flags free models and tolerates unusable pricing', () => {
  const models = parseCatalog(fixture);
  assert.equal(models.find((model) => model.id === 'vendor/generous-model:free')?.free, true);
  assert.equal(models.find((model) => model.id === 'x/plain-tools')?.free, false);
  assert.deepEqual(models.find((model) => model.id === 'vendor/odd-pricing')?.pricing, {
    prompt: 0,
    completion: 0,
  });
});

test('parseCatalog rejects a payload with no usable data', () => {
  assert.throws(() => parseCatalog({ nope: true }), CatalogError);
  assert.throws(
    () => parseCatalog({ data: [{ id: 'x/y', supported_parameters: [] }] }),
    CatalogError,
  );
});

test('the cache path honours XDG_CACHE_HOME and an explicit override', () => {
  assert.equal(
    catalogFile({ platform: 'linux', env: { XDG_CACHE_HOME: '/xdg' }, homedir: '/home/x' }),
    '/xdg/claude-code-openrouter/catalog.json',
  );
  assert.equal(
    catalogFile({ platform: 'linux', env: { OPENROUTER_CATALOG_FILE: '/tmp/x.json' } }),
    '/tmp/x.json',
  );
});

test('loadCatalog fetches, reports the network source and writes the cache', async () => {
  const homedir = await home();
  const load = await loadCatalog({
    ...unix,
    homedir,
    fetch: async () => new Response(JSON.stringify(fixture), { status: 200 }),
  });
  assert.equal(load.source, 'network');
  assert.equal(load.models.length, 5);
  const cached: unknown = JSON.parse(await readFile(catalogFile({ ...unix, homedir }), 'utf8'));
  assert.equal(parseCatalog(cached).length, 5);
});

test('loadCatalog falls back to the cache when the network fails', async () => {
  const homedir = await home();
  const file = catalogFile({ ...unix, homedir });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(fixture));
  const load = await loadCatalog({ ...unix, homedir, fetch: offline });
  assert.equal(load.source, 'cache');
  assert.equal(load.models.length, 5);
});

test('loadCatalog fails explicitly with no network and no cache', async () => {
  const homedir = await home();
  await assert.rejects(loadCatalog({ ...unix, homedir, fetch: offline }), CatalogError);
});

test('loadCatalog keeps a usable cache when upstream answers with an error status', async () => {
  const homedir = await home();
  const file = catalogFile({ ...unix, homedir });
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(fixture));
  const load = await loadCatalog({
    ...unix,
    homedir,
    fetch: async () => new Response('nope', { status: 503 }),
  });
  assert.equal(load.source, 'cache');
});
