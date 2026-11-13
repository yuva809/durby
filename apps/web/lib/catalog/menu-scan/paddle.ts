import type { OcrWord } from './parse';

/**
 * The OCR engine of the menu scan (ADR 0035): PaddleOCR PP-OCRv6 small, text detection and the
 * multilingual recognizer (reads small caps, umlauts and € well), run by ONNX Runtime Web in the
 * browser. Loaded on first use; the models come from a version-pinned copy on Hugging Face and
 * the runtime's WebAssembly from jsDelivr (the exact installed `onnxruntime-web`), both cached by
 * the browser. The images never leave the device.
 */

/** The model repository at a fixed commit, so a scan always reads with the same models. */
const MODELS =
  'https://huggingface.co/snowfluke/ppu-paddle-ocr-models/resolve/3cbb26882389013ed863b66a78e52376b5ff0f0a';
const MODEL = {
  detection: `${MODELS}/detection/PP-OCRv6_small_det.onnx`,
  recognition: `${MODELS}/recognition/PP-OCRv6_small_rec.onnx`,
  charactersDictionary: `${MODELS}/recognition/ppocrv6_dict.txt`,
};
/**
 * The recognizer also knows Chinese, Japanese and Korean, and reads them into photos and patterns
 * (a dish photo yields `大`, `家`): menus here are in Latin script, so such readings are noise.
 */
const NOT_LATIN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
/** Readings below this confidence (0–1) are dropped: specks, rules and patterns, not text. */
const MIN_CONFIDENCE = 0.3;
/** Crops come from the page at full size: scan pages are at most 2400 px (`ocr.ts`). */
const CROP_SOURCE_EDGE = 2400;

/** One text box as the engine returns it. */
export interface PaddleItem {
  text: string;
  box: { x: number; y: number; width: number; height: number };
  /** 0–1. */
  confidence: number;
}

/**
 * The engine's lines (boxes on one row, left to right) → the scan's words, in page pixels: the
 * box moved right by `offsetX` (where the read strip starts) and confidence on the 0–100 scale.
 * Empty and non-Latin readings (`NOT_LATIN`) are dropped, and lines left without words.
 */
export function toOcrWords(lines: readonly (readonly PaddleItem[])[], offsetX = 0): OcrWord[][] {
  return lines
    .map((line) =>
      line
        .map((item) => ({
          text: item.text.trim(),
          confidence: Math.round(item.confidence * 1000) / 10,
          box: {
            x0: item.box.x + offsetX,
            y0: item.box.y,
            x1: item.box.x + item.box.width + offsetX,
            y1: item.box.y + item.box.height,
          },
        }))
        .filter((word) => word.text && !NOT_LATIN.test(word.text)),
    )
    .filter((line) => line.length > 0);
}

export interface Reader {
  /** The lines of words on `canvas`; `offsetX` is where the canvas sits on the page. */
  read(canvas: HTMLCanvasElement, offsetX?: number): Promise<OcrWord[][]>;
  close(): Promise<void>;
}

/** Loads the engine and its models (first use downloads about 20 MB, later uses hit the cache). */
export async function loadReader(): Promise<Reader> {
  const { PaddleOcrService } = await import('ppu-paddle-ocr/web');
  const service = new PaddleOcrService({
    model: MODEL,
    recognition: {
      // One reading per detected box: a name and its price far to the right stay two boxes, and
      // the gap between them is what splits menu columns (`segmentLine`).
      strategy: 'per-box',
      minimumConfidence: MIN_CONFIDENCE,
      maxCropSourceSideLength: CROP_SOURCE_EDGE,
      charactersDictionary: [],
    },
  });
  await service.initialize();
  return {
    async read(canvas, offsetX = 0) {
      const result = await service.recognize(canvas);
      return toOcrWords(result.lines, offsetX);
    },
    close: () => service.destroy(),
  };
}
