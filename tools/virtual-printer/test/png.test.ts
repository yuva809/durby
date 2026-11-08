import { inflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { encodePng } from '../src/png.ts';

function chunks(png: Buffer) {
  const out: { type: string; data: Buffer }[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    out.push({
      type: png.toString('ascii', at + 4, at + 8),
      data: png.subarray(at + 8, at + 8 + length),
    });
    at += 12 + length;
  }
  return out;
}

describe('encodePng', () => {
  it('writes a 1-bit greyscale PNG where printed dots are black', () => {
    // 10 x 2 dots, 2 bytes per row: row 0 has dot 0 and dot 9 black, row 1 is empty.
    const png = encodePng(10, 2, Uint8Array.from([0x80, 0x40, 0x00, 0x00]));

    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const [ihdr, idat, iend] = chunks(png);
    expect(ihdr!.type).toBe('IHDR');
    expect([
      ihdr!.data.readUInt32BE(0),
      ihdr!.data.readUInt32BE(4),
      ihdr!.data[8],
      ihdr!.data[9],
    ]).toEqual([10, 2, 1, 0]);
    expect(iend!.type).toBe('IEND');

    // Filter byte 0, then the row inverted (PNG greyscale: 0 = black). Padding bits are white.
    expect([...inflateSync(idat!.data)]).toEqual([0, 0x7f, 0xbf, 0, 0xff, 0xff]);
  });
});
