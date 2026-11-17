import { describe, expect, it } from 'vitest';
import { requestHash } from '../../platform/idempotency/storage-policy';
import { imageTypeOf } from './catalog.service';

const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);

describe('category tile images (ADR 0048)', () => {
  it('knows WebP, PNG and JPEG by their first bytes, nothing else', () => {
    expect(imageTypeOf(webp)).toBe('image/webp');
    expect(imageTypeOf(png)).toBe('image/png');
    expect(imageTypeOf(jpeg)).toBe('image/jpeg');
    expect(imageTypeOf(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageTypeOf(Buffer.from('GIF89a'))).toBeNull();
    expect(imageTypeOf(Buffer.alloc(0))).toBeNull();
  });

  it('fingerprints a raw upload by its bytes for idempotency', () => {
    const a = requestHash('PUT', '/api/v1/catalog/categories/x/image', png);
    expect(requestHash('PUT', '/api/v1/catalog/categories/x/image', Buffer.from(png))).toBe(a);
    expect(requestHash('PUT', '/api/v1/catalog/categories/x/image', jpeg)).not.toBe(a);
  });
});
