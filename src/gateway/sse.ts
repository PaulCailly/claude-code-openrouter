/** Server-sent events as every provider in this gateway speaks them. */
export async function* readSse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let pending = '';
  let data: string[] = [];
  let dataBytes = 0;
  let totalBytes = 0;
  const addData = (line: string) => {
    dataBytes += Buffer.byteLength(line);
    if (dataBytes > 8 * 1024 * 1024) {
      throw new Error('SSE event exceeds 8 MiB');
    }
    data.push(line);
  };
  const parse = (): unknown => {
    const value = data.join('\n');
    if (Buffer.byteLength(value) > 8 * 1024 * 1024) {
      throw new Error('SSE event exceeds 8 MiB');
    }
    data = [];
    dataBytes = 0;
    return value && value !== '[DONE]' ? JSON.parse(value) : null;
  };
  const consumeLine = (line: string): unknown => {
    if (!line) {
      return parse();
    }
    if (line.startsWith('data:')) {
      addData(line.slice(5).replace(/^ /, ''));
    }
    return null;
  };
  for await (const chunk of stream) {
    totalBytes += chunk.byteLength;
    if (totalBytes > 32 * 1024 * 1024) {
      throw new Error('Response exceeds 32 MiB');
    }
    pending += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(pending) > 8 * 1024 * 1024) {
      throw new Error('SSE buffer exceeds 8 MiB');
    }
    for (let index = pending.indexOf('\n'); index !== -1; index = pending.indexOf('\n')) {
      const line = pending.slice(0, index).replace(/\r$/, '');
      pending = pending.slice(index + 1);
      const event = consumeLine(line);
      if (event) {
        yield event;
      }
    }
  }
  pending += decoder.decode();
  if (pending.startsWith('data:')) {
    addData(pending.slice(5).trimStart());
  }
  const event = parse();
  if (event) {
    yield event;
  }
}

/** Hold suffixes that might become a stop sequence in a later text delta. */
export function prefixSafeLength(text: string, stops: readonly string[]): number {
  let limit = text.length;
  for (const stop of stops) {
    for (let length = 1; length < stop.length; length++) {
      if (text.endsWith(stop.slice(0, length))) {
        limit = Math.min(limit, text.length - length);
      }
    }
  }
  return limit;
}
