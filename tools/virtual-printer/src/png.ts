import { crc32, deflateSync } from 'node:zlib';

/** A 1-bit greyscale PNG from printer bits (row-major, MSB = leftmost dot, 1 = black). */
export function encodePng(widthDots: number, heightDots: number, bits: Uint8Array): Buffer {
  const rowBytes = Math.ceil(widthDots / 8);
  const raw = Buffer.alloc((rowBytes + 1) * heightDots);
  for (let y = 0; y < heightDots; y++) {
    const at = y * (rowBytes + 1);
    raw[at] = 0; // filter: none
    for (let i = 0; i < rowBytes; i++) raw[at + 1 + i] = ~(bits[y * rowBytes + i] ?? 0) & 0xff; // PNG: 0 = black
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(widthDots, 0);
  header.writeUInt32BE(heightDots, 4);
  header[8] = 1; // bit depth
  header[9] = 0; // greyscale
  // compression, filter, interlace: 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}
