import QRCode from 'qrcode';

/** The guest link of a table's QR code (docs/modules/pos.md → QR menu). */
export function menuUrl(origin: string, organizationId: string, menuCode: string): string {
  return `${origin}/menu/${organizationId}.${menuCode}`;
}

/**
 * The QR code of `text` as an SVG data URL: vector, so it prints sharp at any size, and made
 * without a canvas. Error correction M survives a scratched table card.
 */
export async function qrDataUrl(text: string): Promise<string> {
  const svg = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
