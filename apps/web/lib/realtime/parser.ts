/**
 * An incremental event-stream parser (the subset Durby's stream routes send, ADR 0044): `event:` and
 * `data:` fields, `:` comments, blocks ended by a blank line. Chunks may split anywhere, including
 * inside a line or between `\r` and `\n`.
 */
export interface SseParser {
  feed(chunk: string): void;
}

export interface SseCallbacks {
  /** A complete event with its (joined) data. */
  event(name: string, data: string): void;
  /** A comment line (`: ping`), with the leading colon and space removed. */
  comment?(text: string): void;
}

export function createSseParser(callbacks: SseCallbacks): SseParser {
  let buffer = '';
  let name = '';
  let data: string[] = [];
  // A chunk ended in `\r`: the next chunk's leading `\n` belongs to the same line break.
  let pendingCr = false;

  const line = (text: string) => {
    if (text === '') {
      if (data.length > 0) callbacks.event(name || 'message', data.join('\n'));
      name = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) {
      callbacks.comment?.(text.slice(1).trimStart());
      return;
    }
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') name = value;
    else if (field === 'data') data.push(value);
  };

  return {
    feed(chunk) {
      let text = chunk;
      if (pendingCr && text.startsWith('\n')) text = text.slice(1);
      pendingCr = false;
      buffer += text;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const c = buffer[i];
        if (c !== '\n' && c !== '\r') continue;
        line(buffer.slice(start, i));
        if (c === '\r') {
          if (i + 1 === buffer.length) pendingCr = true;
          else if (buffer[i + 1] === '\n') i++;
        }
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },
  };
}
