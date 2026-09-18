import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogModel } from '../../src/openrouter/catalog.ts';
import {
  catalogId,
  pickerOptions,
  RECOMMENDED_IDS,
  reasoningEffort,
  routeId,
  workerDefinitions,
  workerName,
} from '../../src/openrouter/models.ts';

const sonnet: CatalogModel = {
  id: 'anthropic/claude-sonnet-5',
  name: 'Anthropic: Claude Sonnet 5',
  contextLength: 1000000,
  maxOutputTokens: 64000,
  images: true,
  reasoning: true,
  free: false,
  pricing: { prompt: 0.000002, completion: 0.00001 },
};
const plain: CatalogModel = {
  ...sonnet,
  id: 'x/plain-tools',
  name: 'X: Plain Tools',
  images: false,
  reasoning: false,
};
const catalog = [sonnet, plain];

test('route ids round-trip through the openrouter prefix', () => {
  assert.equal(routeId(sonnet.id), 'openrouter/anthropic/claude-sonnet-5');
  assert.equal(catalogId('openrouter/anthropic/claude-sonnet-5'), 'anthropic/claude-sonnet-5');
  assert.equal(catalogId('claude-sonnet-5'), undefined);
  assert.equal(catalogId('openrouter/'), undefined);
});

test('worker names replace slashes so every row has a usable agent name', () => {
  assert.equal(workerName(sonnet.id), 'openrouter-anthropic-claude-sonnet-5');
  assert.equal(workerName('vendor/model:free'), 'openrouter-vendor-model-free');
});

test('an explicit selection keeps its order, drops duplicates and rejects unknown ids', () => {
  const options = pickerOptions(catalog, 'x/plain-tools,anthropic/claude-sonnet-5,x/plain-tools');
  assert.deepEqual(
    options.map((option) => option.catalog.id),
    ['x/plain-tools', 'anthropic/claude-sonnet-5'],
  );
  assert.throws(() => pickerOptions(catalog, 'nope/nope'), /OPENROUTER_MODELS/);
});

test('an empty selection hides every OpenRouter row', () => {
  assert.deepEqual(pickerOptions(catalog, ''), []);
});

test('the default selection keeps recommended ids that the live catalog still has', () => {
  const options = pickerOptions(catalog, undefined);
  assert.deepEqual(
    options.map((option) => option.catalog.id),
    ['anthropic/claude-sonnet-5'],
  );
  assert(RECOMMENDED_IDS.includes('anthropic/claude-sonnet-5'));
});

test('rows describe context, effort support and price without inventing capabilities', () => {
  const [row] = pickerOptions(catalog, 'anthropic/claude-sonnet-5');
  assert.equal(row.model, 'openrouter/anthropic/claude-sonnet-5');
  assert.equal(row.label, 'Anthropic: Claude Sonnet 5');
  assert.match(row.description, /1000k context/);
  assert.match(row.description, /images/);
  const [plainRow] = pickerOptions(catalog, 'x/plain-tools');
  assert.match(plainRow.description, /effort not applicable/);
  assert(!plainRow.description.includes('images'));
});

test('workers exist per row, with effort variants only for reasoning models', () => {
  const agents = workerDefinitions(
    pickerOptions(catalog, 'anthropic/claude-sonnet-5,x/plain-tools'),
  );
  assert.equal(agents['openrouter-anthropic-claude-sonnet-5'].effort, 'medium');
  assert.equal(agents['openrouter-anthropic-claude-sonnet-5-high'].effort, 'high');
  assert.equal(agents['openrouter-x-plain-tools'].effort, undefined);
  assert.equal(agents['openrouter-x-plain-tools-high'], undefined);
  assert.equal(
    agents['openrouter-anthropic-claude-sonnet-5-low'].model,
    'openrouter/anthropic/claude-sonnet-5',
  );
});

test('effort clamps above high and stays absent without reasoning support', () => {
  assert.equal(reasoningEffort(sonnet, 'max'), 'high');
  assert.equal(reasoningEffort(sonnet, 'xhigh'), 'high');
  assert.equal(reasoningEffort(sonnet, 'high'), 'high');
  assert.equal(reasoningEffort(sonnet, 'low'), 'low');
  assert.equal(reasoningEffort(sonnet, 'medium'), 'medium');
  assert.equal(reasoningEffort(sonnet, undefined), undefined);
  assert.equal(reasoningEffort(plain, undefined), undefined);
  assert.throws(() => reasoningEffort(plain, 'high'), /does not support effort/);
});
