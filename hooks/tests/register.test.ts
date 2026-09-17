import { expect, mock, test } from 'claude-code/testing';

test('registers display tools and posts a session snapshot', async ($, on) => {
  mock.env(on, {
    OPENROUTER_GATEWAY_TOKEN: 'test-token',
    OPENROUTER_MOD_GATEWAY_URL: 'http://127.0.0.1:4000',
  });
  on('session.start', () => ({ cwd: '/tmp' }));
  const commands: string[] = [];
  on('command.register', (_$, event) => {
    commands.push(event.name);
    return { value: { command: event.name } };
  });
  const requests: string[] = [];
  on('session.id', () => ({ value: 'test-session' }));
  on('session.cwd', () => ({ value: '/tmp' }));
  on('session.model', () => ({ value: 'openrouter/glm-5.3' }));
  on('tool.register', (_$, event) => ({ value: { tool: `mcp__multi-core__${event.name}` } }));
  on('tool.call', () => ({ value: { result: { type: 'text', text: 'stub' } } }));
  on('ui.status', () => ({ value: undefined }));
  on('ui.invalidate', () => ({ value: undefined }));
  on('http.fetch', (_$, event) => {
    requests.push(event.url);
    return {
      value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ accepted: true }) },
    };
  });
  await $.session.start({ cwd: '/tmp', model: 'openrouter/glm-5.3' });
  expect(requests).toContain('http://127.0.0.1:4000/openrouter/mod/session');
  expect(commands).toEqual(['multi-usage']);
});

test('mod is dormant without launcher environment', async ($, on) => {
  mock.env(on, {});
  on('session.start', () => ({ cwd: '/tmp' }));
  on('command.register', (_$, event) => ({ value: { command: event.name } }));
  on('session.id', () => ({ value: 'inactive-session' }));
  on('session.cwd', () => ({ value: '/tmp' }));
  on('session.model', () => ({ value: 'claude-sonnet' }));
  let fetches = 0;
  on('http.fetch', () => {
    fetches += 1;
    return { value: { status: 200, ok: true, headers: {}, text: '{}' } };
  });
  await $.session.start({ cwd: '/tmp', model: 'claude-sonnet' });
  expect(fetches).toBe(0);
});
