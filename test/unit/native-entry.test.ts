import assert from 'node:assert/strict';
import test from 'node:test';
import type { Plugin } from '../../src/install/plugins.ts';
import {
  providerSelection,
  resolvePluginRoot,
  settingsArguments,
} from '../../src/install/plugins.ts';

const plugin = (overrides: Partial<Plugin> = {}): Plugin => ({
  id: 'openrouter@claude-code-openrouter',
  enabled: true,
  scope: 'user',
  installPath: '/plugins/openrouter',
  ...overrides,
});

test('the enabled user-scope plugin is the launcher root', async () => {
  const root = await resolvePluginRoot({ list: async () => [plugin()] });
  assert.equal(root, '/plugins/openrouter');
});

test('a missing or disabled plugin points at the install commands', async () => {
  await assert.rejects(resolvePluginRoot({ list: async () => [] }), /plugin marketplace add/);
  await assert.rejects(
    resolvePluginRoot({ list: async () => [plugin({ enabled: false })] }),
    /plugin marketplace add/,
  );
});

test('a project-scope-only install is refused', async () => {
  await assert.rejects(
    resolvePluginRoot({ list: async () => [plugin({ scope: 'project' })] }),
    /user scope/,
  );
});

test('another marketplace entry is never mistaken for this plugin', async () => {
  await assert.rejects(
    resolvePluginRoot({ list: async () => [plugin({ id: 'openrouter@someone-else' })] }),
    /plugin marketplace add/,
  );
});

test('provider selection and settings arguments preserve explicit disablement', () => {
  assert.equal(providerSelection(undefined), undefined);
  assert.deepEqual(providerSelection(''), []);
  assert.deepEqual(providerSelection('openrouter,openrouter'), ['openrouter']);
  assert.throws(() => providerSelection('typo'), /Unknown provider/);
  assert.deepEqual(
    settingsArguments([
      '--model',
      'sonnet',
      '--settings={"enabledPlugins":{}}',
      '--setting-sources',
      'user',
      '--',
      '--settings=x',
    ]),
    ['--settings={"enabledPlugins":{}}', '--setting-sources', 'user'],
  );
  assert.throws(() => settingsArguments(['--settings']), /requires a value/);
});
