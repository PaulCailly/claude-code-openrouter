import assert from 'node:assert/strict';
import test from 'node:test';
import { prefixSafeLength, readSse } from '../../src/gateway/sse.ts';

async function* chunks(...parts: string[]) {
  for (const part of parts) {
    yield new TextEncoder().encode(part);
  }
}

test('readSse yields parsed data payloads across chunk boundaries', async () => {
  const seen: unknown[] = [];
  for await (const event of readSse(chunks('data: {"a":', '1}\n\n', 'data: [DONE]\n\n'))) {
    seen.push(event);
  }
  assert.deepEqual(seen, [{ a: 1 }]);
});

test('prefixSafeLength stops before a partial stop sequence', () => {
  assert.equal(prefixSafeLength('hello wor', ['world']), 'hello '.length);
  assert.equal(prefixSafeLength('hello there', ['world']), 'hello there'.length);
});
