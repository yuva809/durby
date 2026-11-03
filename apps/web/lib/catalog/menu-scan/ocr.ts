import { findStrips, prepareForOcr } from './image';
import { joinRows, type OcrLine, orderColumns, segmentLine } from './parse';
import { hasText, type TextItem } from './pdf-text';
import { readingScore } from './reading-score';

/**
 * Menu photos and PDFs → text, entirely in the browser (docs/modules/catalog.md → Menu scan). A
 * PDF's own text is read exactly; photos and image-only PDF pages go through OCR. Tesseract and
 * pdf.js are loaded on first use only. Their worker, engine and language files come
 * from jsDelivr (version-pinned) and are cached by the browser; the images never leave the device.
 */

/** Photos and image-only PDF pages per scan: each is read by OCR, which takes a few seconds. */
export const MAX_SCAN_PAGES = 10;
/** PDF pages per scan when their text is in the PDF (read at once). */
export const MAX_PDF_PAGES = 60;
/** Long edge after scaling: enough for menu text, quick to read. */
const MAX_EDGE = 2400;
/**
 * Smaller images are enlarged to this long edge: OCR needs text at least ~20 px high. Phone
 * screenshots of a menu have print only ~12 px high and need the larger edge.
 */
const MIN_EDGE = 2400;
/** Below this long edge the original is likely too small to read (a thumbnail or chat preview). */
const SMALL_EDGE = 1000;
const LANGUAGES = ['eng', 'deu'];
/** Image-only PDF pages are rendered this large for OCR… */
const PDF_SCALE = 2;
/** …PDF pages with text only for the "Original" preview. */
const PREVIEW_SCALE = 1.5;
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs';

export type ScanErrorKind = 'heic' | 'unsupported' | 'tooManyPages' | 'unreadable';

export class ScanError extends Error {
  constructor(readonly kind: ScanErrorKind) {
    super(kind);
    this.name = 'ScanError';
  }
}

/**
 * One page of the scan with a preview URL. A PDF page that carries its text has `text` (read
 * exactly, in preview pixels) and no canvas; any other page has a prepared canvas for OCR.
 */
export interface ScanPage {
  /** 1-based, as `OcrLine.page`. */
  number: number;
  name: string;
  width: number;
  height: number;
  /** The original is so small that menu text is likely only a few pixels high. */
  small: boolean;
  sourceWidth: number;
  sourceHeight: number;
  canvas: HTMLCanvasElement | null;
  /** The same page scaled but not prepared: clean screenshots read better this way (`readingScore`). */
  plain: HTMLCanvasElement | null;
  text: TextItem[] | null;
  previewUrl: string;
}

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
const isHeic = (file: File) => /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
/** Any image the browser can decode: the type when it is set, else a known extension. */
const isImage = (file: File) =>
  file.type.startsWith('image/') ||
  /\.(jpe?g|jfif|pjpe?g|png|webp|gif|bmp|avif|tiff?|hei[cf])$/i.test(file.name);

type Source =
  | { kind: 'image'; image: CanvasImageSource & { width: number; height: number } }
  | { kind: 'text'; items: TextItem[]; width: number; height: number; previewUrl: string };

/** Validates the files and turns them (PDF pages included) into pages to read. */
export async function preparePages(
  files: readonly File[],
  onProgress?: (progress: OcrProgress) => void,
): Promise<ScanPage[]> {
  for (const file of files) {
    if (!isPdf(file) && !isImage(file)) throw new ScanError('unsupported');
  }
  const pages: ScanPage[] = [];
  let images = 0;
  for (const file of files) {
    const sources: Source[] = isPdf(file)
      ? await pdfPages(file, onProgress)
      : [{ kind: 'image', image: await imageSource(file) }];
    for (const [i, source] of sources.entries()) {
      const name = sources.length > 1 ? `${file.name} (${i + 1})` : file.name;
      const number = pages.length + 1;
      if (number > MAX_PDF_PAGES) throw new ScanError('tooManyPages');
      if (source.kind === 'text') {
        pages.push({
          number,
          name,
          width: source.width,
          height: source.height,
          small: false,
          sourceWidth: source.width,
          sourceHeight: source.height,
          canvas: null,
          plain: null,
          text: source.items,
          previewUrl: source.previewUrl,
        });
        continue;
      }
      images += 1;
      if (images > MAX_SCAN_PAGES) throw new ScanError('tooManyPages');
      const { canvas, plain } = toScanCanvas(source.image);
      pages.push({
        number,
        name,
        width: canvas.width,
        height: canvas.height,
        small: Math.max(source.image.width, source.image.height) < SMALL_EDGE,
        sourceWidth: source.image.width,
        sourceHeight: source.image.height,
        canvas,
        plain,
        text: null,
        previewUrl: canvas.toDataURL('image/jpeg', 0.85),
      });
    }
  }
  return pages;
}

async function imageSource(
  file: File,
): Promise<CanvasImageSource & { width: number; height: number }> {
  try {
    return await createImageBitmap(file);
  } catch {
    // Some formats decode only through an <img> (and HEIC only in Safari).
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return Object.assign(img, { width: img.naturalWidth, height: img.naturalHeight });
    } catch {
      throw new ScanError(isHeic(file) ? 'heic' : 'unreadable');
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** A PDF's pages: their text when they carry it, else a rendered image for OCR. */
async function pdfPages(
  file: File,
  onProgress?: (progress: OcrProgress) => void,
): Promise<Source[]> {
  try {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    if (doc.numPages > MAX_PDF_PAGES) throw new ScanError('tooManyPages');
    const sources: Source[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress?.({ page: n, pages: doc.numPages, progress: 0 });
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const preview = page.getViewport({ scale: PREVIEW_SCALE });
      const items: TextItem[] = [];
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform as number[];
        items.push({
          text: item.str,
          x: e * PREVIEW_SCALE,
          y: preview.height - f * PREVIEW_SCALE,
          width: item.width * PREVIEW_SCALE,
          size: Math.hypot(c, d) * PREVIEW_SCALE,
          rotated: Math.abs(b) > 0.01,
        });
      }
      const text = hasText(items);
      const viewport = text ? preview : page.getViewport({ scale: PDF_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      if (text) {
        const previewUrl = canvas.toDataURL('image/jpeg', 0.7);
        canvas.width = 0; // only the preview is kept
        sources.push({
          kind: 'text',
          items,
          width: viewport.width,
          height: viewport.height,
          previewUrl,
        });
      } else {
        sources.push({ kind: 'image', image: canvas });
      }
      page.cleanup();
    }
    return sources;
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError('unreadable');
  }
}

/**
 * Scaled to between MIN_EDGE and MAX_EDGE (enlarging, smoothed, helps small photos and
 * screenshots), then reduced to the darkest colour channel with stretched levels (`prepareForOcr`).
 * The scaled page before that step is kept as `plain`.
 */
function toScanCanvas(source: CanvasImageSource & { width: number; height: number }) {
  const edge = Math.max(source.width, source.height);
  const scale = edge > MAX_EDGE ? MAX_EDGE / edge : edge < MIN_EDGE ? MIN_EDGE / edge : 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ScanError('unreadable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const plain = document.createElement('canvas');
  plain.width = canvas.width;
  plain.height = canvas.height;
  plain.getContext('2d', { willReadFrequently: true })?.drawImage(canvas, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  prepareForOcr(pixels.data, canvas.width, canvas.height);
  ctx.putImageData(pixels, 0, 0);
  return { canvas, plain };
}

export interface OcrProgress {
  /** 1-based page being read. */
  page: number;
  pages: number;
  /** 0–1 for that page. */
  progress: number;
}

/**
 * Reads every page in one Tesseract worker. `signal` stops early (the worker is terminated).
 * Each page is read twice, prepared (`prepareForOcr`, made for photos) and plain (clean
 * screenshots lose their small print to the preparation), and the reading with the higher
 * `readingScore` is kept. The page is cut into column strips at gutters (`findStrips`) and each
 * strip is read on its own; lines are then split at wide gaps, rejoined by row and ordered column
 * by column.
 */
export async function recognizePages(
  pages: readonly ScanPage[],
  onProgress: (progress: OcrProgress) => void,
  signal?: AbortSignal,
): Promise<OcrLine[]> {
  // PDF pages that carry their text are read by `parseTextPages`, not here.
  const images = pages.filter((p) => p.canvas !== null);
  if (images.length === 0) return [];
  const { createWorker, PSM } = await import('tesseract.js');
  let current = 1;
  /** Which of the page's two readings, and which strip of it, is being read. */
  let share = { variant: 0, index: 0, count: 1 };
  const worker = await createWorker(LANGUAGES, 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') {
        const strip = (share.index + m.progress) / share.count;
        onProgress({ page: current, pages: images.length, progress: (share.variant + strip) / 2 });
      }
    },
  });
  const abort = () => void worker.terminate();
  signal?.addEventListener('abort', abort, { once: true });

  /** One reading of a page from `canvas`. */
  async function read(page: ScanPage, canvas: HTMLCanvasElement, variant: number) {
    // Prepared pages are read by layout analysis; plain ones in sparse mode, which finds the small
    // print of a screenshot that layout analysis skips.
    await worker.setParameters({
      tessedit_pageseg_mode: variant === 0 ? PSM.AUTO : PSM.SPARSE_TEXT,
    });
    // Each column strip is read on its own, so side-by-side menu columns don't mix. The gutters
    // are found on the prepared page (ink on white), for either reading.
    const ctx = page.canvas!.getContext('2d', { willReadFrequently: true });
    const pixels = ctx?.getImageData(0, 0, page.width, page.height).data;
    const strips = pixels
      ? findStrips(pixels, page.width, page.height, 4)
      : [{ x0: 0, x1: page.width }];
    const segments: OcrLine[] = [];
    for (const [index, strip] of strips.entries()) {
      if (signal?.aborted) break;
      share = { variant, index, count: strips.length };
      const crop = document.createElement('canvas');
      crop.width = strip.x1 - strip.x0;
      crop.height = page.height;
      crop.getContext('2d')?.drawImage(canvas, -strip.x0, 0);
      const { data } = await worker.recognize(crop, {}, { blocks: true });
      for (const block of data.blocks ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            const words = line.words
              .map((w) => ({
                text: w.text.trim(),
                confidence: w.confidence,
                box: { ...w.bbox, x0: w.bbox.x0 + strip.x0, x1: w.bbox.x1 + strip.x0 },
              }))
              .filter((w) => w.text);
            segments.push(...segmentLine(words, page.number, index));
          }
        }
      }
    }
    return orderColumns(joinRows(segments), page.width);
  }

  try {
    const lines: OcrLine[] = [];
    for (const [position, page] of images.entries()) {
      if (signal?.aborted) break;
      current = position + 1;
      onProgress({ page: current, pages: images.length, progress: 0 });
      const prepared = await read(page, page.canvas!, 0);
      const plain = page.plain && !signal?.aborted ? await read(page, page.plain, 1) : null;
      lines.push(...(plain && readingScore(plain) > readingScore(prepared) ? plain : prepared));
    }
    return lines;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!signal?.aborted) await worker.terminate();
  }
}
