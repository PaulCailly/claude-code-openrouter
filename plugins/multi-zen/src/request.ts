import type { ContentBlock, MessagesRequest } from '../../multi-core/src/gateway/messages.ts';
import { estimateInputTokens } from '../../multi-core/src/gateway/tokens.ts';
import { toChat } from './chat.ts';
import type { ZenModel } from './models.ts';
import { zenModel } from './models.ts';

function validateMedia(body: MessagesRequest, model: ZenModel) {
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

/** Pure translation keeps repeated prefixes byte-stable; the caller owns credentials. */
export function zenRequest(body: MessagesRequest, cacheKey: string) {
  const model = zenModel(body.model?.replace(/^multi\/zen\//, '') ?? '');
  if (!model || body.model !== `multi/zen/${model.id}`) {
    throw new Error('Unknown Zen model. Run the launcher with --zen-models for supported choices.');
  }
  if (
    body.max_tokens !== undefined &&
    (!Number.isSafeInteger(body.max_tokens) ||
      body.max_tokens < 1 ||
      body.max_tokens > model.maxOutputTokens)
  ) {
    throw new Error(`Zen max_tokens must be between 1 and ${model.maxOutputTokens}`);
  }
  validateMedia(body, model);
  const effort = body.output_config?.effort;
  if (effort !== undefined && model.efforts && !model.efforts.some((value) => value === effort)) {
    throw new Error(
      `${model.id} does not support effort ${effort}. Reset /effort to auto to use its native default.`,
    );
  }
  const chat = toChat(
    { ...body, max_tokens: body.max_tokens ?? Math.min(32000, model.maxOutputTokens) },
    model.id,
  );
  return {
    signaturePrefix: `multi-zen-chat:${model.id}:`,
    inputTokens: estimateInputTokens(chat),
    endpoint: 'chat/completions' as const,
    body: chat,
    cacheKey,
  };
}
