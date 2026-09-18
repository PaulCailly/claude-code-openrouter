import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { executableInvocation } from '../gateway/executable.ts';

const MARKETPLACE = 'claude-code-openrouter';
const PLUGIN_ID = `openrouter@${MARKETPLACE}`;
const PROVIDERS = ['openrouter'] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface Plugin {
  id: string;
  enabled: boolean;
  scope: string;
  installPath: string;
  errors?: unknown;
}

export function providerSelection(value: string | undefined): Provider[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  return [...new Set(value.split(',').filter(Boolean))].map((id) => {
    const provider = PROVIDERS.find((name) => name === id);
    if (!provider) {
      throw new Error(`Unknown provider: ${id}`);
    }
    return provider;
  });
}

function admit(parsed: unknown): Plugin[] {
  if (!Array.isArray(parsed)) {
    throw new Error('Claude returned an invalid plugin list. Update Claude Code and retry.');
  }
  return parsed.filter((item): item is Plugin => {
    return (
      item !== null &&
      typeof item === 'object' &&
      typeof item.id === 'string' &&
      typeof item.enabled === 'boolean' &&
      typeof item.scope === 'string' &&
      typeof item.installPath === 'string' &&
      path.isAbsolute(item.installPath)
    );
  });
}

export interface ResolveOptions {
  list?: () => Promise<Plugin[]>;
  claude?: string;
  platform?: NodeJS.Platform;
}

/** The installed plugin owns the launcher; the npm bin only locates it. */
export async function resolvePluginRoot(options: ResolveOptions = {}): Promise<string> {
  const list =
    options.list ??
    (async () => {
      const invocation = executableInvocation(
        options.claude ?? 'claude',
        ['plugin', 'list', '--json'],
        options.platform ?? process.platform,
      );
      const { stdout } = await promisify(execFile)(invocation.command, invocation.args, {
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
        encoding: 'utf8',
        ...invocation.options,
      });
      return admit(JSON.parse(stdout));
    });
  const plugins = await list();
  const installed = plugins.filter((plugin) => plugin.id === PLUGIN_ID);
  if (!installed.some((plugin) => plugin.enabled)) {
    throw new Error(
      `Install the plugin first: /plugin marketplace add PaulCailly/${MARKETPLACE}, then /plugin install ${PLUGIN_ID}.`,
    );
  }
  const personal = installed.find((plugin) => plugin.enabled && plugin.scope === 'user');
  if (!personal) {
    throw new Error('Enable the openrouter plugin at user scope before launching.');
  }
  return personal.installPath;
}

export function settingsArguments(args: string[]): string[] {
  const selected: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') {
      break;
    }
    if (['--settings', '--setting-sources'].includes(arg)) {
      const value = args[++index];
      if (value === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      selected.push(arg, value);
    } else if (arg.startsWith('--settings=') || arg.startsWith('--setting-sources=')) {
      selected.push(arg);
    }
  }
  return selected;
}
