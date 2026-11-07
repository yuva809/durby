import type { PrintImage } from '@durby/shared';
import { packBits, renderGeometry, toBase64, type Rect } from './raster';

const HOLDER_ID = 'native-print-bill';

/**
 * Styles for the clone only: black on white like the print CSS, and long words wrap instead of pushing prices off
 * the paper. Colour keywords, not tokens: the printer has one ink whatever the theme.
 */
const CLONE_CSS =
  `#${HOLDER_ID},#${HOLDER_ID} *{color:black!important;border-color:black!important;` +
  'background:transparent!important;box-shadow:none!important;min-width:0;overflow-wrap:anywhere}' +
  `#${HOLDER_ID}{background:white!important;position:fixed;left:0;top:0;z-index:-1;` +
  'box-sizing:border-box;padding:0;margin:0;pointer-events:none}';

/** Waits for images by their load event, at most 3 s (not `decode()`: it stalls while the screen is off). */
function imagesLoaded(holder: HTMLElement): Promise<unknown> {
  return Promise.all(
    [...holder.querySelectorAll('img')].map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise((resolve) => {
            img.addEventListener('load', resolve, { once: true });
            img.addEventListener('error', resolve, { once: true });
            setTimeout(resolve, 3_000);
          }),
    ),
  );
}

/** The logo's box in canvas pixels, dithered instead of thresholded. */
function logoRects(holder: HTMLElement, scale: number): Rect[] {
  const logo = holder.querySelector('[data-testid="bill-logo"]');
  if (!logo) return [];
  const h = holder.getBoundingClientRect();
  const r = logo.getBoundingClientRect();
  return [
    {
      x: Math.floor((r.left - h.left) * scale),
      y: Math.floor((r.top - h.top) * scale),
      w: Math.ceil(r.width * scale),
      h: Math.ceil(r.height * scale),
    },
  ];
}

/**
 * Re-lays-out a clone of the rendered bill at the printer's width and turns it into printer dots. The bill
 * component and browser printing are untouched; the converter loads only inside the app.
 */
export async function renderBillImage(bill: HTMLElement, widthDots: number): Promise<PrintImage> {
  const geo = renderGeometry(widthDots);
  const { toCanvas } = await import('html-to-image');
  const style = document.createElement('style');
  style.textContent = CLONE_CSS;
  const holder = document.createElement('div');
  holder.id = HOLDER_ID;
  holder.setAttribute('aria-hidden', 'true');
  holder.style.width = `${geo.cssWidth}px`;
  holder.append(bill.cloneNode(true));
  document.head.append(style);
  document.body.append(holder);
  try {
    await imagesLoaded(holder);
    const canvas = await toCanvas(holder, {
      pixelRatio: geo.pixelRatio,
      backgroundColor: 'white',
      width: geo.cssWidth,
      height: holder.scrollHeight,
    });
    // Exactly `widthDots` wide: an odd width is padded with white on the right, never stretched.
    const fit = document.createElement('canvas');
    fit.width = widthDots;
    fit.height = canvas.height;
    const ctx = fit.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, fit.width, fit.height);
    ctx.drawImage(canvas, 0, 0);
    const pixels = ctx.getImageData(0, 0, fit.width, fit.height).data;
    const bits = packBits(pixels, fit.width, fit.height, logoRects(holder, geo.pixelRatio));
    return { width: fit.width, height: fit.height, data: toBase64(bits) };
  } finally {
    holder.remove();
    style.remove();
  }
}
