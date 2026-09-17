import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProviderUsageDashboard,
  type ProviderUsageView,
} from '../../src/gateway/provider-usage.ts';
import { ReceiptLedger } from '../../src/gateway/receipts.ts';
import { createNativeGateway } from '../../src/gateway/server.ts';

const empty = () => new ReceiptLedger().snapshot();
test('provider dashboard reads every enabled provider and preserves unavailable quota status', async () => {
  const calls: string[] = [];
  const reader = (provider: string) => async (session: string) => {
    calls.push(`${provider}:${session}`);
    return { summary: `${provider} quota`, details: ['Account snapshot'] };
  };
  const dashboard = new ProviderUsageDashboard({
    enabled: ['zen'],
    zen: reader('zen'),
  });
  const result = await dashboard.read('owned', empty());
  assert.deepEqual(calls.sort(), ['zen:owned']);
  assert.deepEqual(
    result.providers.map((row) => row.status),
    ['ready'],
  );
  assert.equal(result.providers[0].summary, 'zen quota');
});

test('provider dashboard isolates errors and explicitly reports disabled and unsupported billing', async () => {
  const dashboard = new ProviderUsageDashboard({
    enabled: ['zen'],
    zen: async () => {
      throw new Error('secret token');
    },
  });
  const result = await dashboard.read('s', empty());
  assert.deepEqual(
    result.providers.map((row) => row.status),
    ['error'],
  );
  assert(!JSON.stringify(result).includes('secret'));
  assert(result.providers[0].details.some((line) => line.includes('billing console')));
});

test('provider dashboard coalesces reads, caches account data, refreshes and keeps session counts fresh', async () => {
  let calls = 0;
  let now = 0;
  const dashboard = new ProviderUsageDashboard({
    enabled: ['zen'],
    now: () => now,
    zen: async (session) => {
      calls++;
      return { summary: session, details: [] };
    },
  });
  const ledger = new ReceiptLedger();
  await Promise.all([
    dashboard.read('a', ledger.snapshot()),
    dashboard.read('a', ledger.snapshot(), true),
  ]);
  assert.equal(calls, 1);
  ledger.observe({ route: 'zen', session: 'a', usage: { input_tokens: 10, output_tokens: 20 } });
  const cached = await dashboard.read('a', ledger.snapshot('a'));
  assert.equal(calls, 1);
  assert(cached.providers[0].details.includes('Tokens: 10 input · 20 output'));
  cached.providers[0].details.push('mutation');
  assert(!(await dashboard.read('a', empty())).providers[0].details.includes('mutation'));
  await dashboard.read('b', empty());
  assert.equal(calls, 2);
  await dashboard.read('a', empty(), true);
  assert.equal(calls, 3);
  now = 30001;
  await dashboard.read('a', empty());
  assert.equal(calls, 4);
});

test('provider menu route is authenticated, session scoped and read-only', async (t) => {
  let reads = 0;
  const dashboard = new ProviderUsageDashboard({
    enabled: ['zen'],
    zen: async (session) => {
      reads++;
      return { summary: session, details: [] };
    },
  });
  const server = createNativeGateway({
    token: 'secret',
    usageDashboard: dashboard,
    fetchImpl: async () => {
      throw new Error('Menu must not infer');
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/multi/mod/usage?sessionId=owned&view=providers`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal(reads, 0);
  const response = await fetch(url, { headers: { 'x-multi-gateway-token': 'secret' } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as ProviderUsageView;
  assert.equal(body.providers[0].summary, 'owned');
  assert.equal(reads, 1);
});
