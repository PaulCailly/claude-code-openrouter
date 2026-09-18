import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { GatewayFetch } from '../../src/gateway/fetch.ts';
import type { GatewayOptions } from '../../src/gateway/server.ts';
import { createNativeGateway } from '../../src/gateway/server.ts';

const catalog = [
  {
    id: 'z-ai/glm-5.3',
    name: 'Z-AI: GLM 5.3',
    contextLength: 1310720,
    maxOutputTokens: 128000,
    images: false,
    reasoning: true,
    free: false,
    pricing: { prompt: 0.0000014, completion: 0.0000028 },
  },
  {
    id: 'z-ai/glm-5.2',
    name: 'Z-AI: GLM 5.2',
    contextLength: 200000,
    maxOutputTokens: 96000,
    images: false,
    reasoning: false,
    free: false,
    pricing: { prompt: 0.0000006, completion: 0.0000022 },
  },
] as const;
const model = 'openrouter/z-ai/glm-5.3';
const request = {
  model,
  max_tokens: 1024,
  system: 'Stable instructions',
  messages: [{ role: 'user', content: 'Hello' }],
  metadata: { user_id: JSON.stringify({ session_id: 'session-one' }) },
};
const headers = {
  'content-type': 'application/json',
  'x-openrouter-gateway-token': 'local-fixture-token',
  authorization: 'Bearer claude-secret-fixture',
  'x-api-key': 'anthropic-secret-fixture',
};

test('disabled providers reject typed models and token counts without upstream requests', async (t) => {
  let requests = 0;
  const url = await gateway(
    t,
    async () => {
      requests++;
      return completion();
    },
    { enabledProviders: [] },
  );
  for (const endpoint of ['/v1/messages', '/v1/messages/count_tokens']) {
    const response = await fetch(`${url}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...request, model: 'openrouter/z-ai/glm-5.3' }),
    });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /not enabled/);
  }
  assert.equal(requests, 0);
});

function completion(tool = false) {
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'Read', arguments: '{"file_path":"fixture"}' },
          },
        ],
      }
    : { content: 'Done' };
  return new Response(
    `data: ${JSON.stringify({
      id: 'chat_fixture',
      choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 12,
        prompt_tokens_details: { cached_tokens: 800, cache_creation_input_tokens: 100 },
      },
    })}\n\ndata: [DONE]\n\n`,
  );
}

async function gateway(
  t: TestContext,
  fetchImpl: GatewayFetch,
  extra: Partial<GatewayOptions> = {},
) {
  const server = createNativeGateway({
    token: 'local-fixture-token',
    openrouter: { apiKey: 'openrouter-secret-fixture', models: catalog },
    blockAnthropic: true,
    fetchImpl,
    ...extra,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

function post(base: string, body: unknown = request, extraHeaders = {}) {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { ...headers, ...extraHeaders },
    body: JSON.stringify(body),
  });
}

test('OpenRouter isolates credentials, keeps cache affinity over restarts, and reports cache writes', async (t) => {
  const sent: { headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const upstream: GatewayFetch = async (url, init) => {
    assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.authorization, 'Bearer openrouter-secret-fixture');
    assert.equal(init.headers['x-api-key'], undefined);
    assert.equal(init.headers['x-openrouter-gateway-token'], undefined);
    assert(!JSON.stringify(init.headers).includes('claude-secret-fixture'));
    sent.push({ headers: init.headers, body: JSON.parse(String(init.body)) });
    return completion();
  };
  const first = await gateway(t, upstream);
  const restarted = await gateway(t, upstream);
  const result = await (await post(first)).json();
  assert(result && typeof result === 'object' && 'model' in result && 'usage' in result);
  assert.equal(result.model, model);
  assert.deepEqual(result.usage, {
    input_tokens: 100,
    output_tokens: 12,
    cache_read_input_tokens: 800,
    cache_creation_input_tokens: 100,
  });
  await (await post(restarted)).arrayBuffer();
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[0].body.max_tokens, 1024);
  await (await post(restarted, request, { 'x-claude-code-agent-id': 'worker-one' })).arrayBuffer();
  await (await post(restarted, { ...request, model: 'openrouter/z-ai/glm-5.2' })).arrayBuffer();
  assert.notEqual(sent[0].headers['x-openrouter-session'], sent[2].headers['x-openrouter-session']);
  assert.notEqual(sent[0].headers['x-openrouter-session'], sent[3].headers['x-openrouter-session']);
});

test('OpenRouter admission and counting never invoke inference; errors retain status without secrets or retries', async (t) => {
  let calls = 0;
  const base = await gateway(t, async () => {
    calls++;
    return new Response('SECRET_PROVIDER_ERROR', { status: 429, headers: { 'retry-after': '7' } });
  });
  const counted = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
  });
  assert.equal(counted.headers.get('x-openrouter-token-count'), 'estimate');
  const count = await counted.json();
  assert(count && typeof count === 'object' && 'input_tokens' in count);
  assert(typeof count.input_tokens === 'number' && count.input_tokens > 0);
  const bad = await post(base, { ...request, model: 'openrouter/nope/nope' });
  assert.equal(bad.status, 400);
  const missing = await gateway(
    t,
    async () => {
      throw new Error('Must not call');
    },
    { openrouter: undefined },
  );
  assert.equal((await post(missing)).status, 400);
  assert.equal(calls, 0);
  const failure = await post(base);
  assert.equal(failure.status, 429);
  assert.equal(failure.headers.get('retry-after'), '7');
  assert.match(await failure.text(), /OpenRouter returned HTTP 429/);
  assert.equal(calls, 1);
});

test('OpenRouter client disconnect aborts the upstream fetch without replay', async (t) => {
  const entered = Promise.withResolvers<void>();
  const aborted = Promise.withResolvers<void>();
  let calls = 0;
  const base = await gateway(t, async (_url, init) => {
    calls++;
    entered.resolve();
    return new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener(
        'abort',
        () => {
          aborted.resolve();
          reject(init.signal.reason);
        },
        { once: true },
      );
    });
  });
  const controller = new AbortController();
  const result = fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...request, stream: true }),
    signal: controller.signal,
  }).catch(() => undefined);
  await entered.promise;
  controller.abort();
  await aborted.promise;
  await result;
  assert.equal(calls, 1);
});

test('OpenRouter refuses invalid credential headers and missing terminal billing counts', async (t) => {
  assert.throws(
    () =>
      createNativeGateway({
        token: 'fixture',
        openrouter: { apiKey: 'secret\nvalue', models: catalog },
      }),
    (error: unknown) =>
      error instanceof Error && !error.message.includes('secret') && /API key/.test(error.message),
  );
  const base = await gateway(
    t,
    async () =>
      new Response(
        `data: ${JSON.stringify({
          id: 'missing_usage',
          choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }],
        })}\n\ndata: [DONE]\n\n`,
      ),
  );
  const response = await post(base);
  assert.equal(response.status, 502);
  assert.match(await response.text(), /omitted terminal usage/);
});
