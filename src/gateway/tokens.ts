import { getEncoding } from 'js-tiktoken';
import type { ChatRequest } from '../openrouter/chat.ts';

let encoding: ReturnType<typeof getEncoding> | undefined;
/** Shared local text estimate; providers may use different tokenizers. */
function estimateTextTokens(value: string): number {
  encoding ??= getEncoding('o200k_base');
  return encoding.encode(value, [], []).length;
}

/** Local estimate, not a provider billing count. Media expansion uses heuristics. */
export function estimateInputTokens(request: ChatRequest): number {
  const text = estimateTextTokens;
  // ponytail: media allowances are heuristic; replace with provider counting when upstream exposes it.
  const parts = (content: unknown): number => {
    if (typeof content === 'string') {
      return text(content);
    }
    if (!Array.isArray(content)) {
      return 0;
    }
    return content.reduce((total: number, part: { type?: string; text?: string }) => {
      if (part.type === 'image_url') {
        return total + 4096;
      }
      return total + text(part.text ?? '');
    }, 0);
  };
  let total = request.tools ? text(JSON.stringify(request.tools)) + 8 : 8;
  for (const message of request.messages) {
    total += 8;
    total += parts(message.content);
    if ('reasoning_content' in message) {
      total += text(message.reasoning_content ?? '');
    }
    if ('tool_calls' in message) {
      for (const call of message.tool_calls ?? []) {
        total += text(call.function.name) + text(call.function.arguments);
      }
    }
  }
  if (request.response_format) {
    total += text(JSON.stringify(request.response_format));
  }
  return total;
}
