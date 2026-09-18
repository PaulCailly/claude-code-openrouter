import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export class OpenRouterAuthError extends Error {}

export interface AuthPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
}

/** Printable ASCII with no spaces: anything else cannot be an API key header. */
export function validateKey(value: string): string {
  if (!/^[\x21-\x7e]+$/.test(value)) {
    throw new OpenRouterAuthError('Invalid OpenRouter API key.');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathForPlatform(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function authFile({
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
}: AuthPathOptions = {}): string {
  if (env.OPENROUTER_AUTH_FILE) {
    return env.OPENROUTER_AUTH_FILE;
  }
  const pathApi = pathForPlatform(platform);
  const base =
    platform === 'win32'
      ? env.APPDATA || pathApi.join(homedir, 'AppData', 'Roaming')
      : env.XDG_CONFIG_HOME || pathApi.join(homedir, '.config');
  return pathApi.join(base, 'claude-code-openrouter', 'auth.json');
}

/** The environment wins; otherwise the plugin's own store owns the key. */
export async function readOpenRouterKey(
  options: AuthPathOptions = {},
): Promise<string | undefined> {
  const configured = (options.env ?? process.env).OPENROUTER_API_KEY;
  if (configured !== undefined) {
    return validateKey(configured);
  }

  let source: string;
  try {
    source = await readFile(authFile(options), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw new OpenRouterAuthError('Cannot read the OpenRouter auth file.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new OpenRouterAuthError('The OpenRouter auth file is invalid.');
  }
  if (!isRecord(parsed) || parsed.openrouter === undefined) {
    return undefined;
  }
  const entry = parsed.openrouter;
  if (
    !isRecord(entry) ||
    entry.type !== 'api' ||
    typeof entry.key !== 'string' ||
    !entry.key.trim()
  ) {
    throw new OpenRouterAuthError('The OpenRouter auth file has invalid credentials.');
  }
  return validateKey(entry.key);
}

/** Written atomically with owner-only mode; unrelated entries are preserved. */
export async function saveOpenRouterKey(key: string, options: AuthPathOptions = {}): Promise<void> {
  const validated = validateKey(key);
  const platform = options.platform ?? process.platform;
  const pathApi = pathForPlatform(platform);
  const file = authFile(options);
  let entries: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!isRecord(parsed)) {
      throw new OpenRouterAuthError('The OpenRouter auth file is invalid.');
    }
    entries = parsed;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw new OpenRouterAuthError(
        'Cannot update the OpenRouter auth file. Existing credentials were preserved.',
      );
    }
  }
  await mkdir(pathApi.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = pathApi.join(
    pathApi.dirname(file),
    `${pathApi.basename(file)}.${process.pid}.tmp`,
  );
  await writeFile(
    temporary,
    `${JSON.stringify({ ...entries, openrouter: { type: 'api', key: validated } }, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );
  await rename(temporary, file);
}
