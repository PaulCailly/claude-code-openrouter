#!/usr/bin/env node
// Self-contained on purpose: Node refuses to strip types for files under
// node_modules, so this entry point imports nothing from src/. It locates the
// installed plugin and hands off to the launcher that ships inside it.
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const PLUGIN_ID = 'openrouter@claude-code-openrouter';
const MANAGEMENT = ['connect', 'status', 'models', 'uninstall'];

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 12)) {
  console.error(
    `claude-openrouter needs Node >= 24.12 (running ${process.versions.node}). The plugin runs TypeScript directly.`,
  );
  process.exit(1);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const args = process.argv.slice(2);
const management = MANAGEMENT.includes(args[0]);

let stdout;
try {
  ({ stdout } = await promisify(execFile)('claude', ['plugin', 'list', '--json'], {
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  }));
} catch (error) {
  fail(`claude-openrouter cannot run claude: ${error instanceof Error ? error.message : error}`);
}

let plugins;
try {
  plugins = JSON.parse(stdout);
} catch {
  fail('Claude returned an invalid plugin list. Update Claude Code and retry.');
}
if (!Array.isArray(plugins)) {
  fail('Claude returned an invalid plugin list. Update Claude Code and retry.');
}

const installed = plugins.filter((plugin) => plugin?.id === PLUGIN_ID && plugin.enabled);
if (!installed.length) {
  fail(
    'Install the plugin first: /plugin marketplace add PaulCailly/claude-code-openrouter, then ' +
      `/plugin install ${PLUGIN_ID}.`,
  );
}
const personal = installed.find(
  (plugin) => plugin.scope === 'user' && typeof plugin.installPath === 'string',
);
if (!personal) {
  fail('Enable the openrouter plugin at user scope before launching.');
}

const entry = path.join(personal.installPath, 'src', management ? 'account.ts' : 'launcher.ts');
const child = spawn(process.execPath, [entry, ...args], {
  stdio: 'inherit',
  env: { ...process.env, OPENROUTER_PLUGIN_ROOT: personal.installPath },
});
child.on('error', (error) => fail(`claude-openrouter could not start: ${error.message}`));
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
