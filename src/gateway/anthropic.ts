import type { MessagesRequest } from './messages.ts';

/** Signature prefixes this gateway stamps on foreign reasoning blocks. */
const FOREIGN_SIGNATURE_PREFIXES: readonly string[] = [
  'multi-openai:',
  'multi-zen-responses:',
  'multi-zen-chat:',
];

/** Strip foreign reasoning before a request reaches Anthropic, which rejects it. */
export function forAnthropic(body: MessagesRequest): MessagesRequest {
  let changed = false;
  const messages = body.messages
    ?.map((message) => {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        return message;
      }
      const content = message.content.filter((block) => {
        const foreign =
          block.type === 'thinking' &&
          FOREIGN_SIGNATURE_PREFIXES.some((prefix) => block.signature?.startsWith(prefix));
        changed ||= Boolean(foreign);
        return !foreign;
      });
      return { ...message, content };
    })
    .filter((message) => !Array.isArray(message.content) || message.content.length);
  return changed ? { ...body, messages } : body;
}
