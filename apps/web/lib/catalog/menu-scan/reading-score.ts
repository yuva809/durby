import { type OcrLine, parseMenu } from './parse';

/**
 * How well a reading of a page worked (docs/modules/catalog.md → Menu scan): the confidence of
 * every product it yields that has a real word in its name. Image preparation that helps photos
 * can erase the small print of a clean screenshot, so each page is read prepared and plain and
 * the higher score is kept.
 */
export function readingScore(lines: readonly OcrLine[]): number {
  return parseMenu(lines)
    .flatMap((category) => category.products)
    .reduce((sum, p) => sum + ((p.name.match(/\p{L}/gu)?.length ?? 0) >= 3 ? p.confidence : 0), 0);
}
