import type { Effort } from '../gateway/effort.ts';
import type { ContentBlock, MessagesRequest } from '../gateway/messages.ts';
import { estimateInputTokens } from '../gateway/tokens.ts';
import type { CatalogModel } from './catalog.ts';
import type { ChatRequest } from './chat.ts';
import { toChat } from './chat.ts';
import type { ReasoningEffort } from './models.ts';
import { reasoningEffort } from './models.ts';

export interface PreparedRequest {
  body: ChatRequest & {
    usage: { include: true };
    reasoning?: { effort: ReasoningEffort };
    provider?: Record<string, unknown>;
  };
  inputTokens: number;
  signaturePrefix: string;
}

export interface RequestOptions {
  /** Raw JSON from OPENROUTER_PROVIDER, merged into the request's provider field. */
  providerJson?: string;
}

function validateMedia(body: MessagesRequest, model: CatalogModel) {
  const check = (block: ContentBlock) => {
    if (block.type === 'image' && !model.images) {
      throw new Error(`${model.id} does not support images in this integration`);
    }
    if (block.type === 'document') {
      throw new Error(`${model.id} does not accept PDF input in this integration`);
    }
  };
  for (const message of body.messages ?? []) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      check(block);
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const part of block.content) {
          check(part);
        }
      }
    }
  }
}

function providerPreferences(json: string | undefined): Record<string, unknown> | undefined {
  if (json === undefined || json.trim() === '') {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(
      `OPENROUTER_PROVIDER must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('OPENROUTER_PROVIDER must be a JSON object of provider routing preferences.');
  }
  return parsed as Record<string, unknown>;
}

/** Pure translation keeps repeated prefixes byte-stable; the caller owns credentials. */
export function openrouterRequest(
  body: MessagesRequest,
  model: CatalogModel,
  options: RequestOptions = {},
): PreparedRequest {
  if (
    body.max_tokens !== undefined &&
    (!Number.isSafeInteger(body.max_tokens) ||
      body.max_tokens < 1 ||
      body.max_tokens > model.maxOutputTokens)
  ) {
    throw new Error(`OpenRouter max_tokens must be between 1 and ${model.maxOutputTokens}`);
  }
  validateMedia(body, model);
  const effort = reasoningEffort(model, body.output_config?.effort as Effort | undefined);
  const provider = providerPreferences(options.providerJson);
  const chat = toChat(
    { ...body, max_tokens: body.max_tokens ?? Math.min(32000, model.maxOutputTokens) },
    model.id,
  );
  return {
    signaturePrefix: `openrouter-chat:${model.id}:`,
    inputTokens: estimateInputTokens(chat),
    body: {
      ...chat,
      usage: { include: true },
      ...(effort ? { reasoning: { effort } } : {}),
      ...(provider ? { provider } : {}),
    },
  };
}
