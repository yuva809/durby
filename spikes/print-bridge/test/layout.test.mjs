// Pure layout helpers of spike.js (node --test spikes/print-bridge/test). The DOM part (checkReflow)
// runs against fake-bridge.mjs in a browser; see ../README.md → Developer checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../android/app/src/main/assets/spike.js');

test('58 mm (384 dots) lays the bill out at 192 css px, 2 dots per px: reflow, not shrink', () => {
  assert.deepEqual(L.renderGeometry(384), { cssWidth: 192, pixelRatio: 2, canvasWidth: 384 });
});

test('80 mm widths keep the same text size: 576 → 288 px, 512 → 256 px', () => {
  assert.deepEqual(L.renderGeometry(576), { cssWidth: 288, pixelRatio: 2, canvasWidth: 576 });
  assert.deepEqual(L.renderGeometry(512), { cssWidth: 256, pixelRatio: 2, canvasWidth: 512 });
});

test('the scale never depends on the paper, so 12 px Durby text is 24 dots (3 mm) on every printer', () => {
  for (const dots of [384, 512, 576]) assert.equal(L.renderGeometry(dots).pixelRatio * 12, 24);
});

test('an odd width rounds down and the canvas never exceeds the printer', () => {
  assert.deepEqual(L.renderGeometry(383), { cssWidth: 191, pixelRatio: 2, canvasWidth: 382 });
});

test('nonsense widths are refused', () => {
  assert.throws(() => L.renderGeometry(0));
  assert.throws(() => L.renderGeometry(undefined));
  assert.throws(() => L.renderGeometry(5000));
});

const rgba = (w, h, gray) => {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([gray, gray, gray, 255], i * 4);
  return px;
};
const black = (bits, w, x, y) => (bits[y * Math.ceil(w / 8) + (x >> 3)] & (0x80 >> (x & 7))) !== 0;

test('a 384-dot row packs into 48 bytes, leftmost dot in the high bit', () => {
  const px = rgba(384, 1, 255);
  px.set([0, 0, 0, 255], 0); // x = 0
  px.set([0, 0, 0, 255], 383 * 4); // x = 383
  const bits = L.packBits(px, 384, 1);
  assert.equal(bits.length, 48);
  assert.equal(bits[0], 0x80);
  assert.equal(bits[47], 0x01);
  assert.equal(
    bits.slice(1, 47).every((b) => b === 0),
    true,
  );
});

test('text is thresholded: dark gray prints, light gray and transparent do not', () => {
  const px = new Uint8ClampedArray([100, 100, 100, 255, 200, 200, 200, 255, 0, 0, 0, 0]);
  const bits = L.packBits(px, 3, 1);
  assert.equal(black(bits, 3, 0, 0), true);
  assert.equal(black(bits, 3, 1, 0), false);
  assert.equal(black(bits, 3, 2, 0), false);
});

test('the logo area is dithered: mid gray becomes about half black, the rest stays thresholded', () => {
  const w = 64;
  const h = 32;
  const bits = L.packBits(rgba(w, h, 170), w, h, [{ x: 0, y: 0, w: 32, h: 32 }]);
  let inside = 0;
  let outside = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (black(bits, w, x, y)) x < 32 ? inside++ : outside++;
  // 170/255 ≈ 67 % white → about a third black inside; 170 ≥ 160 → all white outside.
  assert.ok(inside > 1024 * 0.25 && inside < 1024 * 0.42, `inside ${inside}`);
  assert.equal(outside, 0);
});

test('the clone styles are scoped to the spike bill and force black on white', () => {
  assert.match(L.BILL_CSS, /^#bridge-spike-bill,#bridge-spike-bill \*\{color:#000!important/);
  assert.match(L.BILL_CSS, /overflow-wrap:anywhere/);
  assert.doesNotMatch(L.BILL_CSS.replace(/#bridge-spike-bill/g, ''), /#[a-z-]+\s*[{,]/i);
});
