import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ENDPOINT = 'https://openrouter.ai/api/v1/models';

export class CatalogError extends Error {}

/** One admitted model, described only by what the payload states. */
export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number;
  maxOutputTokens: number;
  images: boolean;
  reasoning: boolean;
  free: boolean;
  pricing: { prompt: number; completion: number };
}

export interface CatalogLoad {
  models: CatalogModel[];
  source: 'network' | 'cache';
  fetchedAt: string;
}

export interface CatalogOptions {
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function price(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function admit(entry: unknown): CatalogModel | undefined {
  if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) {
    return undefined;
  }
  const parameters: unknown[] = Array.isArray(entry.supported_parameters)
    ? entry.supported_parameters
    : [];
  // A model that cannot call tools cannot drive a Claude Code session.
  if (!parameters.includes('tools')) {
    return undefined;
  }
  const contextLength =
    typeof entry.context_length === 'number' && entry.context_length > 0 ? entry.context_length : 0;
  if (!contextLength) {
    return undefined;
  }
  const architecture = isRecord(entry.architecture) ? entry.architecture : {};
  const modalities: unknown[] = Array.isArray(architecture.input_modalities)
    ? architecture.input_modalities
    : [];
  const top = isRecord(entry.top_provider) ? entry.top_provider : {};
  const pricing = isRecord(entry.pricing) ? entry.pricing : {};
  return {
    id: entry.id,
    name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
    contextLength,
    maxOutputTokens:
      typeof top.max_completion_tokens === 'number' && top.max_completion_tokens > 0
        ? top.max_completion_tokens
        : contextLength,
    images: modalities.includes('image'),
    reasoning: parameters.includes('reasoning'),
    free: entry.id.endsWith(':free'),
    pricing: { prompt: price(pricing.prompt), completion: price(pricing.completion) },
  };
}

/** Capabilities come from the payload; nothing is inferred from a model id. */
export function parseCatalog(payload: unknown): CatalogModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new CatalogError('OpenRouter returned an unrecognised model list.');
  }
  const models: CatalogModel[] = [];
  for (const entry of payload.data) {
    const model = admit(entry);
    if (model) {
      models.push(model);
    }
  }
  if (!models.length) {
    throw new CatalogError('OpenRouter returned no tool-capable models.');
  }
  return models;
}

export function catalogFile(options: CatalogOptions = {}): string {
  const env = options.env ?? process.env;
  if (env.OPENROUTER_CATALOG_FILE) {
    return env.OPENROUTER_CATALOG_FILE;
  }
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir();
  const api = platform === 'win32' ? path.win32 : path.posix;
  const base =
    platform === 'win32'
      ? env.LOCALAPPDATA || api.join(homedir, 'AppData', 'Local')
      : env.XDG_CACHE_HOME || api.join(homedir, '.cache');
  return api.join(base, 'claude-code-openrouter', 'catalog.json');
}

async function readCache(file: string): Promise<CatalogLoad | undefined> {
  try {
    const [source, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
    return {
      models: parseCatalog(JSON.parse(source)),
      source: 'cache',
      fetchedAt: info.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function writeCache(file: string, payload: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, payload, 'utf8');
  await rename(temporary, file);
}

/** The network owns the catalog; the cache only covers an outage. */
export async function loadCatalog(options: CatalogOptions = {}): Promise<CatalogLoad> {
  const file = catalogFile(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? 10000));
  try {
    const response = await (options.fetch ?? fetch)(ENDPOINT, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CatalogError(`OpenRouter model list returned HTTP ${response.status}.`);
    }
    const body = await response.text();
    const models = parseCatalog(JSON.parse(body));
    await writeCache(file, body).catch(() => undefined);
    return { models, source: 'network', fetchedAt: new Date().toISOString() };
  } catch (error) {
    const cached = await readCache(file);
    if (cached) {
      return cached;
    }
    throw new CatalogError(
      `Cannot read the OpenRouter model list and no cached copy exists (${error instanceof Error ? error.message : String(error)}). Check https://status.openrouter.ai.`,
    );
  } finally {
    clearTimeout(timer);
  }
}
