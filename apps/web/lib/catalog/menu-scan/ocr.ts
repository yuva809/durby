import { type OcrLine, orderColumns, segmentLine } from './parse';

/**
 * Menu photos and PDFs → OCR lines, entirely in the browser (docs/modules/catalog.md → Menu scan).
 * Tesseract and pdf.js are loaded on first use only. Their worker, engine and language files come
 * from jsDelivr (version-pinned) and are cached by the browser; the images never leave the device.
 */

export const MAX_SCAN_PAGES = 10;
/** Long edge after scaling: enough for menu text, quick to read. */
const MAX_EDGE = 2400;
const LANGUAGES = ['eng', 'deu'];
const PDF_SCALE = 2;
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/build/pdf.worker.min.mjs';

export type ScanErrorKind = 'heic' | 'unsupported' | 'tooManyPages' | 'unreadable';

export class ScanError extends Error {
  constructor(readonly kind: ScanErrorKind) {
    super(kind);
    this.name = 'ScanError';
  }
}

/** One page to read: a scaled, greyscaled canvas and a preview URL of the same pixels. */
export interface ScanPage {
  /** 1-based, as `OcrLine.page`. */
  number: number;
  name: string;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
  previewUrl: string;
}

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
const isHeic = (file: File) => /hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
const isImage = (file: File) =>
  /^image\/(jpeg|png|webp)$/.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name);

/** Validates the files and turns them (PDF pages included) into pages ready for OCR. */
export async function preparePages(files: readonly File[]): Promise<ScanPage[]> {
  for (const file of files) {
    if (isHeic(file)) throw new ScanError('heic');
    if (!isPdf(file) && !isImage(file)) throw new ScanError('unsupported');
  }
  const pages: ScanPage[] = [];
  for (const file of files) {
    const sources = isPdf(file) ? await pdfPages(file) : [await imageSource(file)];
    for (const [i, source] of sources.entries()) {
      if (pages.length >= MAX_SCAN_PAGES) throw new ScanError('tooManyPages');
      const canvas = toScanCanvas(source);
      pages.push({
        number: pages.length + 1,
        name: sources.length > 1 ? `${file.name} (${i + 1})` : file.name,
        width: canvas.width,
        height: canvas.height,
        canvas,
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
    throw new ScanError('unreadable');
  }
}

async function pdfPages(file: File): Promise<HTMLCanvasElement[]> {
  try {
    const pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    if (doc.numPages > MAX_SCAN_PAGES) throw new ScanError('tooManyPages');
    const canvases: HTMLCanvasElement[] = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: PDF_SCALE });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvas, viewport }).promise;
      canvases.push(canvas);
    }
    return canvases;
  } catch (error) {
    if (error instanceof ScanError) throw error;
    throw new ScanError('unreadable');
  }
}

/** Scaled to at most MAX_EDGE, greyscale with a little contrast: faster and cleaner OCR. */
function toScanCanvas(source: CanvasImageSource & { width: number; height: number }) {
  const scale = Math.min(1, MAX_EDGE / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ScanError('unreadable');
  ctx.filter = 'grayscale(1) contrast(1.25)';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
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
 * Lines are split at column gaps and read column by column (`segmentLine`, `orderColumns`).
 */
export async function recognizePages(
  pages: readonly ScanPage[],
  onProgress: (progress: OcrProgress) => void,
  signal?: AbortSignal,
): Promise<OcrLine[]> {
  const { createWorker } = await import('tesseract.js');
  let current = 1;
  const worker = await createWorker(LANGUAGES, 1, {
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') {
        onProgress({ page: current, pages: pages.length, progress: m.progress });
      }
    },
  });
  const abort = () => void worker.terminate();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const lines: OcrLine[] = [];
    for (const page of pages) {
      if (signal?.aborted) break;
      current = page.number;
      onProgress({ page: page.number, pages: pages.length, progress: 0 });
      const { data } = await worker.recognize(page.canvas, {}, { blocks: true });
      const segments = (data.blocks ?? []).flatMap((block) =>
        block.paragraphs.flatMap((paragraph) =>
          paragraph.lines.flatMap((line) =>
            segmentLine(
              line.words
                .map((w) => ({ text: w.text.trim(), confidence: w.confidence, box: w.bbox }))
                .filter((w) => w.text),
              page.number,
            ),
          ),
        ),
      );
      lines.push(...orderColumns(segments, page.width));
    }
    return lines;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!signal?.aborted) await worker.terminate();
  }
}
