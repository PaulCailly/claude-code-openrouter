import type { Effort } from '../gateway/effort.ts';
import type { CatalogModel } from './catalog.ts';

const PREFIX = 'openrouter/';

/**
 * Curation is static on purpose: the catalog carries no ranking field, so a live
 * sort would reorder the picker at random. Ids missing from the live catalog drop
 * out silently, which shrinks the list instead of breaking the launch.
 */
export const RECOMMENDED_IDS: readonly string[] = Object.freeze([
  'anthropic/claude-sonnet-5',
  'openai/gpt-6-astra',
  'google/gemini-3.8-flash',
  'x-ai/grok-4.6',
  'moonshotai/kimi-k3',
  'z-ai/glm-5.3',
  'deepseek/deepseek-v4.1-flash',
  'qwen/qwen3.8-max-0902',
]);

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ModelOption {
  model: string;
  worker: string;
  label: string;
  description: string;
  catalog: CatalogModel;
}

export interface WorkerModel {
  model: string;
  effort?: ReasoningEffort;
}

export function routeId(id: string): string {
  return `${PREFIX}${id}`;
}

export function catalogId(route: string): string | undefined {
  const id = route.startsWith(PREFIX) ? route.slice(PREFIX.length) : '';
  return id || undefined;
}

export function workerName(id: string): string {
  return `openrouter-${id.replaceAll(/[/:]/g, '-')}`;
}

function describe(model: CatalogModel): string {
  const parts = [`${Math.round(model.contextLength / 1000)}k context`];
  parts.push(model.reasoning ? 'effort supported' : 'native reasoning; /effort not applicable');
  if (model.images) {
    parts.push('images');
  }
  parts.push(
    model.free ? 'free tier' : `$${(model.pricing.prompt * 1e6).toFixed(2)}/M input tokens`,
  );
  return `OpenRouter · ${parts.join(' · ')}`;
}

function option(model: CatalogModel): ModelOption {
  return {
    model: routeId(model.id),
    worker: workerName(model.id),
    label: model.name,
    description: describe(model),
    catalog: model,
  };
}

/** `undefined` selects the recommended rows; `''` hides every OpenRouter row. */
export function pickerOptions(
  models: readonly CatalogModel[],
  selection: string | undefined,
): ModelOption[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  if (selection === undefined) {
    return RECOMMENDED_IDS.flatMap((id) => {
      const model = byId.get(id);
      return model ? [option(model)] : [];
    });
  }
  const ids = [
    ...new Set(
      selection
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    ),
  ];
  return ids.map((id) => {
    const model = byId.get(id);
    if (!model) {
      throw new Error(
        `OPENROUTER_MODELS: unknown or tool-incapable OpenRouter model: ${id}. Run claude-openrouter models for the admitted catalog.`,
      );
    }
    return option(model);
  });
}

export function workerDefinitions(options: readonly ModelOption[]): Record<string, WorkerModel> {
  const agents: Record<string, WorkerModel> = {};
  for (const item of options) {
    agents[item.worker] = {
      model: item.model,
      ...(item.catalog.reasoning ? { effort: 'medium' as const } : {}),
    };
    if (!item.catalog.reasoning) {
      continue;
    }
    for (const effort of ['low', 'medium', 'high'] as const) {
      agents[`${item.worker}-${effort}`] = { model: item.model, effort };
    }
  }
  return agents;
}

/** OpenRouter exposes three levels; Claude's xhigh and max clamp to high. */
export function reasoningEffort(
  model: CatalogModel,
  effort: Effort | undefined,
): ReasoningEffort | undefined {
  if (effort === undefined) {
    return undefined;
  }
  if (!model.reasoning) {
    throw new Error(
      `${model.id} does not support effort ${effort}. Reset /effort to auto to use its native default.`,
    );
  }
  return effort === 'low' || effort === 'medium' ? effort : 'high';
}
