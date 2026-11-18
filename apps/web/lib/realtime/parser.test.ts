import { describe, expect, it } from 'vitest';
import { createSseParser } from './parser';

function collect(chunks: string[]) {
  const events: [string, string][] = [];
  const comments: string[] = [];
  const parser = createSseParser({
    event: (name, data) => events.push([name, data]),
    comment: (text) => comments.push(text),
  });
  for (const chunk of chunks) parser.feed(chunk);
  return { events, comments };
}

const STREAM =
  'event: ready\ndata: {"heartbeatMs":15000}\n\n: ping\n\nevent: changed\ndata: {"topic":"reservations","ids":[]}\n\n';

describe('createSseParser', () => {
  it('reads events and comments', () => {
    expect(collect([STREAM])).toEqual({
      events: [
        ['ready', '{"heartbeatMs":15000}'],
        ['changed', '{"topic":"reservations","ids":[]}'],
      ],
      comments: ['ping'],
    });
  });

  it('gives the same result however the chunks are split', () => {
    const whole = collect([STREAM]);
    for (let size = 1; size <= 7; size++) {
      const chunks: string[] = [];
      for (let i = 0; i < STREAM.length; i += size) chunks.push(STREAM.slice(i, i + size));
      expect(collect(chunks)).toEqual(whole);
    }
  });

  it('accepts CRLF and CR line endings, even split between chunks', () => {
    const crlf = STREAM.replace(/\n/g, '\r\n');
    expect(collect([crlf])).toEqual(collect([STREAM]));
    expect(collect(crlf.split(/(?<=\r)/))).toEqual(collect([STREAM]));
    expect(collect([STREAM.replace(/\n/g, '\r')])).toEqual(collect([STREAM]));
  });

  it('joins multi-line data, defaults the name, and waits for the blank line', () => {
    expect(collect(['data: a\ndata: b\n\n']).events).toEqual([['message', 'a\nb']]);
    expect(collect(['event: changed\ndata: {}\n']).events).toEqual([]);
    expect(collect(['event: resync\n\n']).events).toEqual([]);
  });
});
