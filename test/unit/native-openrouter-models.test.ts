import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  authFile,
  OpenRouterAuthError,
  readOpenRouterKey,
  saveOpenRouterKey,
  validateKey,
} from '../../src/openrouter/auth.ts';
import {
  OPENROUTER_MODELS,
  OPENROUTER_WORKERS,
  openrouterModelOptions,
  openrouterPickerOptions,
} from '../../src/openrouter/models.ts';

function hostAuthOptions(dataHome: string) {
  const env: NodeJS.ProcessEnv = { OPENROUTER_API_KEY: undefined };
  if (process.platform === 'win32') {
    env.LOCALAPPDATA = dataHome;
  } else {
    env.XDG_DATA_HOME = dataHome;
  }
  return { platform: process.platform, env };
}

async function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('OpenRouter auth resolves Unix and Windows OpenRouter data roots with explicit overrides', () => {
  assert.equal(
    authFile({ platform: 'linux', homedir: '/home/test', env: {} }),
    '/home/test/.local/share/opencode/auth.json',
  );
  assert.equal(
    authFile({
      platform: 'darwin',
      homedir: '/Users/test',
      env: { XDG_DATA_HOME: '/custom/data' },
    }),
    '/custom/data/opencode/auth.json',
  );
  assert.equal(
    authFile({
      platform: 'win32',
      homedir: 'C:\\Users\\test',
      env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' },
    }),
    'C:\\Users\\test\\AppData\\Local\\opencode\\auth.json',
  );
  assert.equal(
    authFile({
      platform: 'win32',
      homedir: 'C:\\Users\\test',
      env: { OPENCODE_AUTH_FILE: 'D:\\auth.json' },
    }),
    'D:\\auth.json',
  );
});

test('OpenRouter auth prefers an explicit API key without exposing its value', async () => {
  await withEnvironment(
    { OPENROUTER_API_KEY: 'fixture-key', XDG_DATA_HOME: '/missing' },
    async () => {
      assert.equal(await readOpenRouterKey(), 'fixture-key');
    },
  );
});

test('OpenRouter key validation rejects whitespace, controls, and non-ASCII without echoing input', async () => {
  for (const value of ['', 'fixture key', 'fixture\nkey', 'fixture\tkey', 'clé']) {
    assert.throws(
      () => validateKey(value),
      (error: unknown) => error instanceof OpenRouterAuthError,
    );
  }
  assert.throws(
    () => validateKey('fixture\nSECRET_INVALID_KEY'),
    (error: unknown) =>
      error instanceof OpenRouterAuthError && !error.message.includes('SECRET_INVALID_KEY'),
  );
  assert.equal(validateKey('visible-ASCII_fixture.key'), 'visible-ASCII_fixture.key');
});

test('an explicit OpenRouter env key prevents reading saved auth', async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'openrouter-auth-test-'));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const directory = path.join(dataHome, 'opencode');
  await mkdir(directory);
  await writeFile(path.join(directory, 'auth.json'), '{malformed');
  await withEnvironment(
    { OPENROUTER_API_KEY: 'env-fixture-key', XDG_DATA_HOME: dataHome },
    async () => {
      assert.equal(await readOpenRouterKey(), 'env-fixture-key');
    },
  );
});

test('OpenRouter auth reads only the official OpenRouter API entry', async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'openrouter-auth-test-'));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const directory = path.join(dataHome, 'opencode');
  await mkdir(directory);
  await writeFile(
    path.join(directory, 'auth.json'),
    JSON.stringify({ opencode: { type: 'api', key: 'saved-fixture-key' } }),
  );
  const options = hostAuthOptions(dataHome);
  await withEnvironment(options.env, async () => {
    assert.equal(await readOpenRouterKey(options), 'saved-fixture-key');
  });
});

test('OpenRouter auth treats missing credentials as optional and rejects malformed explicit config', async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'openrouter-auth-test-'));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const options = hostAuthOptions(dataHome);
  await withEnvironment(options.env, async () => {
    const environmentOptions = { platform: options.platform, env: process.env };
    assert.equal(await readOpenRouterKey(environmentOptions), undefined);
    for (const value of [' ', 'fixture key', 'fixture\nkey']) {
      process.env.OPENROUTER_API_KEY = value;
      await assert.rejects(readOpenRouterKey(environmentOptions), (error: unknown) => {
        assert(error instanceof OpenRouterAuthError);
        return true;
      });
    }
  });
});

test('OpenRouter auth rejects malformed saved credentials without including secrets', async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'openrouter-auth-test-'));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const directory = path.join(dataHome, 'opencode');
  await mkdir(directory);
  await writeFile(path.join(directory, 'auth.json'), '{"opencode":{"type":"api"}}');
  const options = hostAuthOptions(dataHome);
  await withEnvironment(options.env, async () => {
    await assert.rejects(
      readOpenRouterKey(options),
      (error: unknown) => error instanceof OpenRouterAuthError && !error.message.includes('SECRET'),
    );
  });
});

test('OpenRouter catalog exposes bounded protocols and only supported effort workers', () => {
  assert.deepEqual(
    OPENROUTER_MODELS.map((model) => [model.id, model.protocol]),
    [
      ['gpt-5.6-luna', 'responses'],
      ['gpt-5.6-terra', 'responses'],
      ['gpt-5.6-sol', 'responses'],
      ['kimi-k2.7-code', 'chat'],
      ['glm-5.2', 'chat'],
      ['minimax-m2.7', 'chat'],
      ['big-pickle', 'chat'],
      ['mimo-v2.5-free', 'chat'],
      ['ling-3.0-flash-fin-free', 'chat'],
      ['nemotron-3-ultra-free', 'chat'],
      ['nemotron-3.5-lightning-free', 'chat'],
      ['muse-spark-1.3-contributor-free', 'responses'],
      ['muse-spark-1.2-contributor-free', 'responses'],
      ['deepseek-v4-pro', 'chat'],
      ['deepseek-v4-flash', 'chat'],
      ['kimi-k3', 'chat'],
      ['glm-5.3', 'chat'],
      ['glm-5.3-flash', 'chat'],
      ['muse-spark-1.3', 'responses'],
    ],
  );
  assert.equal(openrouterModelOptions(['big-pickle'])[0].model, 'openrouter/big-pickle');
  assert.equal(OPENROUTER_WORKERS['openrouter-big-pickle'].effort, undefined);
  assert.equal(OPENROUTER_WORKERS['openrouter-gpt-5.6-luna'].effort, 'medium');
  assert.equal(OPENROUTER_WORKERS['openrouter-gpt-5.6-luna-high'].effort, 'high');
  assert.equal(OPENROUTER_WORKERS['openrouter-gpt-5.6-luna-impossible'], undefined);
});

test('OpenRouter picker allowlist preserves order and validates model IDs', () => {
  assert.deepEqual(
    openrouterPickerOptions(undefined).map((model) => model.id),
    [
      'deepseek-v4-pro',
      'deepseek-v4-flash',
      'kimi-k3',
      'glm-5.3',
      'glm-5.3-flash',
      'muse-spark-1.3',
    ],
  );
  assert.deepEqual(openrouterPickerOptions(''), []);
  assert.deepEqual(
    openrouterPickerOptions(' mimo-v2.5-free, big-pickle,mimo-v2.5-free ').map((model) => model.id),
    ['mimo-v2.5-free', 'big-pickle'],
  );
  assert.throws(
    () => openrouterPickerOptions('typo'),
    /OPENROUTER_MODELS: unknown OpenRouter model/,
  );
});

test('OpenRouter local key entry preserves other accounts and writes a private auth file', async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), 'openrouter-connect-test-'));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const directory = path.join(dataHome, 'opencode');
  await mkdir(directory);
  const file = path.join(directory, 'auth.json');
  await writeFile(file, JSON.stringify({ other: { type: 'api', key: 'other-fixture' } }));
  const options = hostAuthOptions(dataHome);
  await withEnvironment(options.env, async () => {
    await saveOpenRouterKey('new-fixture', options);
    assert.equal(await readOpenRouterKey(options), 'new-fixture');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).other.key, 'other-fixture');
    if (process.platform !== 'win32') {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    await writeFile(file, 'invalid-json');
    await assert.rejects(saveOpenRouterKey('next-fixture', options), /preserved/);
    assert.equal(await readFile(file, 'utf8'), 'invalid-json');
  });
});
