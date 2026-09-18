import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCredits, readCredits } from '../../src/openrouter/usage.ts';

const answer =
  (body: unknown, status = 200) =>
  async () =>
    new Response(JSON.stringify(body), { status });

test('credits are read and the remainder computed', async () => {
  const result = await readCredits({
    apiKey: 'sk-or-v1-x',
    fetch: answer({ data: { total_credits: 25, total_usage: 4.5 } }),
  });
  assert.deepEqual(result, {
    status: 'available',
    totalCredits: 25,
    totalUsage: 4.5,
    remaining: 20.5,
  });
});

test('a missing key is reported, not treated as an error', async () => {
  assert.deepEqual(await readCredits({ apiKey: '', fetch: answer({}) }), {
    status: 'unavailable',
    reason: 'missing-key',
  });
});

test('401 and 403 report unauthorized', async () => {
  assert.deepEqual(await readCredits({ apiKey: 'sk-or-v1-x', fetch: answer({}, 401) }), {
    status: 'unavailable',
    reason: 'unauthorized',
  });
  assert.deepEqual(await readCredits({ apiKey: 'sk-or-v1-x', fetch: answer({}, 403) }), {
    status: 'unavailable',
    reason: 'unauthorized',
  });
});

test('an unrecognised body reports malformed rather than throwing', async () => {
  assert.deepEqual(
    await readCredits({ apiKey: 'sk-or-v1-x', fetch: answer({ data: { nope: 1 } }) }),
    { status: 'unavailable', reason: 'malformed' },
  );
});

test('a network failure or upstream error degrades instead of throwing', async () => {
  assert.deepEqual(
    await readCredits({
      apiKey: 'sk-or-v1-x',
      fetch: async () => {
        throw new Error('offline');
      },
    }),
    { status: 'unavailable', reason: 'network' },
  );
  assert.deepEqual(await readCredits({ apiKey: 'sk-or-v1-x', fetch: answer({}, 503) }), {
    status: 'unavailable',
    reason: 'network',
  });
});

test('an invalid key never reaches the network', async () => {
  let called = false;
  const result = await readCredits({
    apiKey: 'bad key',
    fetch: async () => {
      called = true;
      return new Response('{}');
    },
  });
  assert.equal(called, false);
  assert.deepEqual(result, { status: 'unavailable', reason: 'unauthorized' });
});

test('the formatted view never claims a balance it does not have', () => {
  assert.equal(formatCredits({ status: 'unavailable', reason: 'network' }).status, 'error');
  assert.equal(
    formatCredits({ status: 'unavailable', reason: 'missing-key' }).status,
    'unavailable',
  );
  const ready = formatCredits({
    status: 'available',
    totalCredits: 25,
    totalUsage: 4.5,
    remaining: 20.5,
  });
  assert.equal(ready.status, 'ready');
  assert.match(ready.summary, /\$20\.50 of \$25\.00 remaining/);
  assert(ready.details.some((line) => line.includes('openrouter.ai/credits')));
});
