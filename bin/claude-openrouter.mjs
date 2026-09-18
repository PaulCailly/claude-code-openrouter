#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 12)) {
  console.error(
    `claude-openrouter needs Node >= 24.12 (running ${process.versions.node}). The plugin runs TypeScript directly.`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const management = ['connect', 'status', 'models', 'uninstall'].includes(args[0]);

let root;
try {
  const { resolvePluginRoot } = await import(
    pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'install', 'plugins.ts')).href
  );
  root = await resolvePluginRoot();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const entry = path.join(root, 'src', management ? 'account.ts' : 'launcher.ts');
const child = spawn(process.execPath, [entry, ...args], {
  stdio: 'inherit',
  env: { ...process.env, OPENROUTER_PLUGIN_ROOT: root, OPENROUTER_ENABLED_PROVIDERS: 'openrouter' },
});
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
