import assert from 'node:assert/strict';
import test from 'node:test';
import type { MessagesRequest } from '../../src/gateway/messages.ts';
import type { CatalogModel } from '../../src/openrouter/catalog.ts';
import { openrouterRequest } from '../../src/openrouter/request.ts';

const model: CatalogModel = {
  id: 'anthropic/claude-sonnet-5',
  name: 'Anthropic: Claude Sonnet 5',
  contextLength: 1000000,
  maxOutputTokens: 64000,
  images: true,
  reasoning: true,
  free: false,
  pricing: { prompt: 0.000002, completion: 0.00001 },
};
const textOnly: CatalogModel = { ...model, id: 'x/text-only', images: false, reasoning: false };
const base: MessagesRequest = {
  model: 'openrouter/anthropic/claude-sonnet-5',
  max_tokens: undefined,
  messages: [{ role: 'user', content: 'hi' }],
};

test('every request asks upstream for real usage accounting', () => {
  assert.deepEqual(openrouterRequest(base, model).body.usage, { include: true });
});

test('effort becomes an OpenRouter reasoning block, clamped at high', () => {
  const prepared = openrouterRequest({ ...base, output_config: { effort: 'max' } }, model);
  assert.deepEqual(prepared.body.reasoning, { effort: 'high' });
  assert.deepEqual(
    openrouterRequest({ ...base, output_config: { effort: 'low' } }, model).body.reasoning,
    { effort: 'low' },
  );
  assert.equal(openrouterRequest(base, model).body.reasoning, undefined);
});

test('a model without reasoning support rejects an explicit effort', () => {
  assert.throws(
    () =>
      openrouterRequest(
        { ...base, model: 'openrouter/x/text-only', output_config: { effort: 'high' } },
        textOnly,
      ),
    /does not support effort/,
  );
});

test('max_tokens above the model ceiling is rejected and the default stays below it', () => {
  assert.throws(() => openrouterRequest({ ...base, max_tokens: 64001 }, model), /1 and 64000/);
  assert.throws(() => openrouterRequest({ ...base, max_tokens: 0 }, model), /1 and 64000/);
  assert.equal(openrouterRequest(base, model).body.max_tokens, 32000);
  assert.equal(openrouterRequest(base, { ...model, maxOutputTokens: 4096 }).body.max_tokens, 4096);
});

test('images are rejected for a text-only model and accepted for a vision model', () => {
  const withImage: MessagesRequest = {
    ...base,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ],
  };
  assert.throws(
    () => openrouterRequest({ ...withImage, model: 'openrouter/x/text-only' }, textOnly),
    /does not support images/,
  );
  assert.doesNotThrow(() => openrouterRequest(withImage, model));
});

test('PDF input is rejected, naming the model', () => {
  const withPdf: MessagesRequest = {
    ...base,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'AA' },
          },
        ],
      },
    ],
  };
  assert.throws(() => openrouterRequest(withPdf, model), /anthropic\/claude-sonnet-5/);
});

test('OPENROUTER_PROVIDER json is merged into the provider field and validated', () => {
  const prepared = openrouterRequest(base, model, { providerJson: '{"order":["anthropic"]}' });
  assert.deepEqual(prepared.body.provider, { order: ['anthropic'] });
  assert.equal(openrouterRequest(base, model).body.provider, undefined);
  assert.throws(() => openrouterRequest(base, model, { providerJson: '{' }), /OPENROUTER_PROVIDER/);
  assert.throws(
    () => openrouterRequest(base, model, { providerJson: '["nope"]' }),
    /OPENROUTER_PROVIDER/,
  );
});

test('the prepared request carries a model-scoped signature prefix and an input estimate', () => {
  const prepared = openrouterRequest(base, model);
  assert.equal(prepared.signaturePrefix, 'openrouter-chat:anthropic/claude-sonnet-5:');
  assert(prepared.inputTokens > 0);
  assert.equal(prepared.body.model, 'anthropic/claude-sonnet-5');
});
