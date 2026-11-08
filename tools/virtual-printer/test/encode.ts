/**
 * ESC/POS encoders for the tests, byte for byte the ones the app sends (spikes/print-bridge EscPos.kt, reused in
 * A3). Bits are row-major, most significant bit = leftmost dot, 1 = black.
 */

export const INIT = [0x1b, 0x40];
export const cut = (feed = 3) => [0x1d, 0x56, 66, feed];
export const feed = (lines: number) => [0x1b, 0x64, lines];
export const align = (n: number) => [0x1b, 0x61, n];
export const bold = (on: boolean) => [0x1b, 0x45, on ? 1 : 0];
export const statusQuery = (n: number) => [0x10, 0x04, n];
export const kickDrawer = (pin5 = false) => [0x1b, 0x70, pin5 ? 1 : 0, 25, 250];
export const line = (text: string) => [...Buffer.from(text, 'ascii'), 0x0a];

export const bytesPerRow = (widthDots: number) => Math.ceil(widthDots / 8);

export function raster(
  widthDots: number,
  heightDots: number,
  bits: Uint8Array,
  bandRows = 256,
): number[] {
  const rowBytes = bytesPerRow(widthDots);
  const out: number[] = [];
  for (let row = 0; row < heightDots; row += bandRows) {
    const rows = Math.min(bandRows, heightDots - row);
    out.push(0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, rowBytes >> 8, rows & 0xff, rows >> 8);
    out.push(...bits.subarray(row * rowBytes, (row + rows) * rowBytes));
  }
  return out;
}

export function escStar(widthDots: number, heightDots: number, bits: Uint8Array): number[] {
  const rowBytes = bytesPerRow(widthDots);
  const dot = (x: number, y: number) =>
    y < heightDots && ((bits[y * rowBytes + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;
  const out: number[] = [0x1b, 0x33, 24];
  for (let top = 0; top < heightDots; top += 24) {
    out.push(0x1b, 0x2a, 33, widthDots & 0xff, widthDots >> 8);
    for (let x = 0; x < widthDots; x++) {
      for (let k = 0; k < 3; k++) {
        let b = 0;
        for (let bit = 0; bit < 8; bit++) if (dot(x, top + k * 8 + bit)) b |= 0x80 >> bit;
        out.push(b);
      }
    }
    out.push(0x0a);
  }
  out.push(0x1b, 0x32);
  return out;
}

/** A recognisable picture: a border, a diagonal and a filled block, so stitching or shifting errors show. */
export function pattern(widthDots: number, heightDots: number): Uint8Array {
  const rowBytes = bytesPerRow(widthDots);
  const bits = new Uint8Array(rowBytes * heightDots);
  const set = (x: number, y: number) => {
    bits[y * rowBytes + (x >> 3)]! |= 0x80 >> (x & 7);
  };
  for (let y = 0; y < heightDots; y++) {
    for (let x = 0; x < widthDots; x++) {
      const border = x === 0 || y === 0 || x === widthDots - 1 || y === heightDots - 1;
      const diagonal = x === Math.floor((y * widthDots) / heightDots);
      const block = x >= 10 && x < 30 && y >= 5 && y < 15;
      if (border || diagonal || block) set(x, y);
    }
  }
  return bits;
}
