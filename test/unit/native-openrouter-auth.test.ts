import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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

const unix = { platform: 'linux' as const, env: {} };
const home = () => mkdtemp(path.join(os.tmpdir(), 'openrouter-auth-'));

test('the environment key wins over the store', async () => {
  const key = await readOpenRouterKey({
    ...unix,
    env: { OPENROUTER_API_KEY: 'sk-or-v1-env' },
    homedir: '/nonexistent',
  });
  assert.equal(key, 'sk-or-v1-env');
});

test('a missing store reads as undefined rather than failing', async () => {
  assert.equal(await readOpenRouterKey({ ...unix, homedir: await home() }), undefined);
});

test('a saved key round-trips and the file stays owner-only', async () => {
  const homedir = await home();
  await saveOpenRouterKey('sk-or-v1-abc', { ...unix, homedir });
  assert.equal(await readOpenRouterKey({ ...unix, homedir }), 'sk-or-v1-abc');
  const info = await stat(authFile({ ...unix, homedir }));
  assert.equal(info.mode & 0o777, 0o600);
});

test('saving twice replaces the key and keeps unrelated entries', async () => {
  const homedir = await home();
  await saveOpenRouterKey('sk-or-v1-first', { ...unix, homedir });
  const file = authFile({ ...unix, homedir });
  const stored: Record<string, unknown> = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...stored, other: { keep: true } }), { mode: 0o600 });
  await saveOpenRouterKey('sk-or-v1-second', { ...unix, homedir });
  assert.equal(await readOpenRouterKey({ ...unix, homedir }), 'sk-or-v1-second');
  const after: Record<string, unknown> = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(after.other, { keep: true });
});

test('keys with whitespace, control characters or no content are rejected', () => {
  assert.throws(() => validateKey('sk or v1'), OpenRouterAuthError);
  assert.throws(() => validateKey(''), OpenRouterAuthError);
  assert.throws(() => validateKey('sk-or-v1\nvalue'), OpenRouterAuthError);
  assert.equal(validateKey('sk-or-v1-abc'), 'sk-or-v1-abc');
});

test('an unreadable or malformed store fails explicitly instead of silently', async () => {
  const homedir = await home();
  const file = authFile({ ...unix, homedir });
  await writeFile(file.replace(/\/[^/]+$/, ''), '', { flag: 'a' }).catch(() => undefined);
  await saveOpenRouterKey('sk-or-v1-abc', { ...unix, homedir });
  await writeFile(file, '{ not json');
  await assert.rejects(readOpenRouterKey({ ...unix, homedir }), OpenRouterAuthError);
});

test('the store path follows the platform config directory', () => {
  assert.equal(
    authFile({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, homedir: '/home/x' }),
    '/xdg/claude-code-openrouter/auth.json',
  );
  assert.equal(
    authFile({ platform: 'linux', env: {}, homedir: '/home/x' }),
    '/home/x/.config/claude-code-openrouter/auth.json',
  );
  assert.equal(
    authFile({ platform: 'win32', env: { APPDATA: 'C:\\Users\\x\\AppData\\Roaming' } }),
    'C:\\Users\\x\\AppData\\Roaming\\claude-code-openrouter\\auth.json',
  );
  assert.equal(
    authFile({ platform: 'linux', env: { OPENROUTER_AUTH_FILE: '/tmp/auth.json' } }),
    '/tmp/auth.json',
  );
});
