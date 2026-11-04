import { describe, expect, it } from 'vitest';
import { LOGO_MAX_HEIGHT, LOGO_MAX_WIDTH, logoSize, toGrayOnWhite } from './bill-logo';

describe('bill logo', () => {
  it('shrinks into the logo box keeping the aspect ratio, never enlarging', () => {
    expect(logoSize(1200, 400)).toEqual({ width: LOGO_MAX_WIDTH, height: 128 });
    expect(logoSize(400, 800)).toEqual({ width: 96, height: LOGO_MAX_HEIGHT });
    expect(logoSize(100, 50)).toEqual({ width: 100, height: 50 });
  });

  it('turns colors gray and transparency white', () => {
    const red = [255, 0, 0, 255];
    const transparent = [0, 0, 0, 0];
    const black = [0, 0, 0, 255];
    const pixels = new Uint8ClampedArray([...red, ...transparent, ...black]);
    toGrayOnWhite(pixels);
    expect([...pixels]).toEqual([76, 76, 76, 255, 255, 255, 255, 255, 0, 0, 0, 255]);
  });
});
