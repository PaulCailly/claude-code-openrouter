import {
  type AuthPathOptions,
  OpenRouterAuthError,
  readOpenRouterKey,
  validateKey,
} from './auth.ts';

const ENDPOINT = 'https://openrouter.ai/api/v1/credits';

export type CreditsResult =
  | { status: 'available'; totalCredits: number; totalUsage: number; remaining: number }
  | {
      status: 'unavailable';
      reason: 'missing-key' | 'unauthorized' | 'network' | 'malformed';
    };

export interface CreditsOptions extends AuthPathOptions {
  apiKey?: string;
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCredits(value: unknown): CreditsResult {
  if (!isRecord(value) || !isRecord(value.data)) {
    return { status: 'unavailable', reason: 'malformed' };
  }
  const { total_credits: credits, total_usage: usage } = value.data;
  if (
    typeof credits !== 'number' ||
    !Number.isFinite(credits) ||
    typeof usage !== 'number' ||
    !Number.isFinite(usage)
  ) {
    return { status: 'unavailable', reason: 'malformed' };
  }
  return {
    status: 'available',
    totalCredits: credits,
    totalUsage: usage,
    remaining: credits - usage,
  };
}

/** Read-only and never fatal: a missing balance must not block a run. */
export async function readCredits(options: CreditsOptions = {}): Promise<CreditsResult> {
  let key: string | undefined;
  try {
    if (options.apiKey === undefined) {
      key = await readOpenRouterKey(options);
    } else if (options.apiKey) {
      key = validateKey(options.apiKey);
    }
  } catch (error) {
    if (error instanceof OpenRouterAuthError) {
      return { status: 'unavailable', reason: 'unauthorized' };
    }
    throw error;
  }
  if (!key) {
    return { status: 'unavailable', reason: 'missing-key' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? 5000));
  try {
    const response = await (options.fetch ?? fetch)(options.endpoint ?? ENDPOINT, {
      method: 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return { status: 'unavailable', reason: 'unauthorized' };
    }
    if (!response.ok) {
      return { status: 'unavailable', reason: 'network' };
    }
    return parseCredits(await response.json());
  } catch {
    return { status: 'unavailable', reason: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

const CONSOLE = 'Top up or review spend at https://openrouter.ai/credits.';

export function formatCredits(result: CreditsResult): {
  status: 'ready' | 'unavailable' | 'error';
  summary: string;
  details: string[];
} {
  if (result.status === 'unavailable') {
    if (result.reason === 'missing-key') {
      return {
        status: 'unavailable',
        summary: 'No OpenRouter API key',
        details: ['Run claude-openrouter connect to store a key.', CONSOLE],
      };
    }
    return {
      status: 'error',
      summary: 'OpenRouter credit balance unavailable',
      details: ['Check the OpenRouter API key and connection, then refresh.', CONSOLE],
    };
  }
  const money = (value: number) => `$${value.toFixed(2)}`;
  return {
    status: 'ready',
    summary: `${money(result.remaining)} of ${money(result.totalCredits)} remaining`,
    details: [
      `Purchased: ${money(result.totalCredits)} · spent: ${money(result.totalUsage)}`,
      'Account-wide OpenRouter credits, not this session alone.',
      CONSOLE,
    ],
  };
}
