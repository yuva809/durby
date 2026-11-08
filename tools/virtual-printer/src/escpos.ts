/**
 * Reads the ESC/POS subset the Durby Android app sends (docs/modules/android-app.md) and draws what a thermal
 * printer would print. Strict on purpose: anything it doesn't know is an error, so a wrong byte in the app shows
 * up in tests instead of on paper.
 */

/** How the printer behaves: answers to status queries, and how the connection fails. */
export const MODES = ['ok', 'paper-out', 'cover-open', 'silent', 'disconnect', 'stall'] as const;
export type Mode = (typeof MODES)[number];

export type Align = 'left' | 'center' | 'right';

export type Event =
  | { type: 'init' }
  | { type: 'text'; text: string; align: Align; bold: boolean }
  | { type: 'feed'; lines: number }
  | { type: 'raster'; mode: 'gsV0' | 'escStar'; widthDots: number; heightDots: number }
  | { type: 'cut'; partial: boolean }
  | { type: 'drawer'; pin: 2 | 5; onMs: number; offMs: number }
  | { type: 'status'; n: number };

/** One piece of paper: from the start of the job or the last cut to the next cut (or the end of the job). */
export interface Page {
  widthDots: number;
  heightDots: number;
  /** Row-major, most significant bit = leftmost dot, 1 = black. */
  bits: Uint8Array;
  cut: boolean;
}

export interface Result {
  events: Event[];
  pages: Page[];
  errors: string[];
}

/** Replies to DLE EOT n, as the app reads them (EscPos.kt PrinterStatus.parse). null = no answer. */
export function statusReply(mode: Mode, n: number): number | null {
  if (mode === 'silent') return null;
  const paperOut = mode === 'paper-out';
  const coverOpen = mode === 'cover-open';
  const fixed = 0x12;
  switch (n) {
    case 1: // printer: bit 3 offline
      return fixed | (paperOut || coverOpen ? 0x08 : 0);
    case 2: // offline cause: bit 2 cover open, bit 5 stopped by paper end
      return fixed | (coverOpen ? 0x04 : 0) | (paperOut ? 0x20 : 0);
    case 3: // error cause
      return fixed;
    case 4: // paper sensor: bits 5+6 paper end
      return fixed | (paperOut ? 0x60 : 0);
    default:
      return null;
  }
}

const ESC = 0x1b;
const GS = 0x1d;
const DLE = 0x10;
const LF = 0x0a;
const CR = 0x0d;

/** Font A on a 203 dpi printer: 12 x 24 dots per character. */
const CHAR_W = 12;
const CHAR_H = 24;
/** ESC 2 default line spacing, in dots. */
const DEFAULT_SPACING = 30;
/** Refuse absurd images instead of allocating them (the app caps a job at 2 MB). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const hex = (bytes: ArrayLike<number>) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

export interface InterpreterOptions {
  /** Printable width of the paper in dots (58 mm: 384). */
  paperDots: number;
  /** Called for each DLE EOT n as soon as it arrives, so the server can answer before the job ends. */
  onStatus?: (n: number) => void;
}

/** Fed with TCP chunks as they arrive; keeps an unfinished command until the rest comes. */
export class Interpreter {
  private readonly paperDots: number;
  private readonly rowBytes: number;
  private readonly onStatus: (n: number) => void;
  private pending = new Uint8Array(0);
  private offset = 0;

  private readonly events: Event[] = [];
  private readonly errors: string[] = [];
  private readonly pages: Page[] = [];

  private rows: Uint8Array[] = [];
  private y = 0;
  private spacing = DEFAULT_SPACING;
  private alignment: Align = 'left';
  private emphasis = false;
  private text = '';

  constructor(options: InterpreterOptions) {
    this.paperDots = options.paperDots;
    this.rowBytes = Math.ceil(options.paperDots / 8);
    this.onStatus = options.onStatus ?? (() => {});
  }

  push(chunk: Uint8Array): void {
    const buf = new Uint8Array(this.pending.length + chunk.length);
    buf.set(this.pending);
    buf.set(chunk, this.pending.length);
    let at = 0;
    while (at < buf.length) {
      const used = this.command(buf, at);
      if (used === 0) break; // incomplete: wait for more bytes
      at += used;
    }
    this.offset += at;
    this.pending = buf.slice(at);
  }

  end(): Result {
    if (this.pending.length > 0) {
      this.errors.push(`truncated: ${this.pending.length} bytes of an unfinished command`);
    }
    this.flushText();
    if (this.y > 0) this.endPage(false);
    return { events: this.events, pages: this.pages, errors: this.errors };
  }

  /** Handles the command at [at]; returns the bytes it used, or 0 if it is not complete yet. */
  private command(buf: Uint8Array, at: number): number {
    const b = buf[at]!;
    const need = (n: number) => at + n <= buf.length;
    const arg = (i: number) => buf[at + i]!;

    if (b === LF) {
      this.flushText(true);
      return 1;
    }
    if (b === CR) return 1;
    if (b >= 0x20 && b !== 0x7f) {
      this.text += b < 0x80 ? String.fromCharCode(b) : '?';
      return 1;
    }

    if (b === DLE) {
      if (!need(3)) return 0;
      if (arg(1) === 0x04) {
        this.events.push({ type: 'status', n: arg(2) });
        this.onStatus(arg(2));
        return 3;
      }
      return this.unknown(buf, at, 2);
    }

    if (b === ESC) {
      if (!need(2)) return 0;
      switch (arg(1)) {
        case 0x40: // ESC @
          this.flushText();
          this.alignment = 'left';
          this.emphasis = false;
          this.spacing = DEFAULT_SPACING;
          this.events.push({ type: 'init' });
          return 2;
        case 0x32: // ESC 2
          this.spacing = DEFAULT_SPACING;
          return 2;
        case 0x33: // ESC 3 n
          if (!need(3)) return 0;
          this.spacing = arg(2);
          return 3;
        case 0x61: // ESC a n
          if (!need(3)) return 0;
          this.alignment = (['left', 'center', 'right'] as const)[arg(2) % 48] ?? 'left';
          return 3;
        case 0x45: // ESC E n
          if (!need(3)) return 0;
          this.emphasis = (arg(2) & 1) === 1;
          return 3;
        case 0x64: // ESC d n
          if (!need(3)) return 0;
          this.flushText();
          this.events.push({ type: 'feed', lines: arg(2) });
          this.advance(arg(2) * this.spacing);
          return 3;
        case 0x70: // ESC p m t1 t2
          if (!need(5)) return 0;
          this.events.push({
            type: 'drawer',
            pin: (arg(2) & 1) === 1 ? 5 : 2,
            onMs: arg(3) * 2,
            offMs: arg(4) * 2,
          });
          return 5;
        case 0x2a: // ESC * m nL nH d...
          return this.escStar(buf, at);
        default:
          return this.unknown(buf, at, 2);
      }
    }

    if (b === GS) {
      if (!need(2)) return 0;
      switch (arg(1)) {
        case 0x76: // GS v 0 m xL xH yL yH d...
          return this.gsV0(buf, at);
        case 0x56: {
          // GS V m [n]
          if (!need(3)) return 0;
          const m = arg(2);
          const withFeed = m === 65 || m === 66;
          if (!withFeed && ![0, 1, 48, 49].includes(m)) return this.unknown(buf, at, 3);
          if (withFeed && !need(4)) return 0;
          // The feed before the cut only moves the paper to the blade; it isn't drawn.
          this.flushText();
          const partial = m === 1 || m === 49 || m === 66;
          this.events.push({ type: 'cut', partial });
          this.endPage(true);
          return withFeed ? 4 : 3;
        }
        default:
          return this.unknown(buf, at, 2);
      }
    }

    return this.unknown(buf, at, 1);
  }

  private gsV0(buf: Uint8Array, at: number): number {
    if (at + 8 > buf.length) return 0;
    if (buf[at + 2] !== 0x30) return this.unknown(buf, at, 3);
    const mode = buf[at + 3]!;
    const rowBytes = buf[at + 4]! | (buf[at + 5]! << 8);
    const height = buf[at + 6]! | (buf[at + 7]! << 8);
    const size = rowBytes * height;
    if (size > MAX_IMAGE_BYTES)
      return this.fatal(`image_too_large: ${rowBytes * 8} x ${height} dots`, buf, at);
    if (at + 8 + size > buf.length) return 0;
    if (mode !== 0 && mode !== 48)
      this.errors.push(`unsupported: GS v 0 scaling mode ${mode} at ${this.offset + at}`);
    const width = rowBytes * 8;
    this.flushText();
    this.events.push({ type: 'raster', mode: 'gsV0', widthDots: width, heightDots: height });
    this.checkWidth(width);
    for (let r = 0; r < height; r++) {
      const row = this.row(this.y + r);
      const src = buf.subarray(at + 8 + r * rowBytes, at + 8 + (r + 1) * rowBytes);
      row.set(src.subarray(0, Math.min(rowBytes, this.rowBytes)));
    }
    this.y += height;
    return 8 + size;
  }

  private escStar(buf: Uint8Array, at: number): number {
    if (at + 5 > buf.length) return 0;
    const m = buf[at + 2]!;
    const columns = buf[at + 3]! | (buf[at + 4]! << 8);
    if (m !== 32 && m !== 33)
      return this.fatal(`unsupported: ESC * mode ${m} (only 24-dot modes)`, buf, at);
    const size = columns * 3;
    if (at + 5 + size > buf.length) return 0;
    this.flushText();
    this.events.push({ type: 'raster', mode: 'escStar', widthDots: columns, heightDots: 24 });
    this.checkWidth(columns);
    for (let x = 0; x < columns && x < this.paperDots; x++) {
      for (let k = 0; k < 3; k++) {
        const b = buf[at + 5 + x * 3 + k]!;
        for (let bit = 0; bit < 8; bit++) {
          if (b & (0x80 >> bit)) this.set(x, this.y + k * 8 + bit);
        }
      }
    }
    // The stripe is drawn at the current line; the LF that follows moves down by the line spacing.
    this.row(this.y + 23);
    return 5 + size;
  }

  private checkWidth(width: number) {
    if (width > this.paperDots)
      this.errors.push(`wider_than_paper: ${width} dots on ${this.paperDots}`);
  }

  private unknown(buf: Uint8Array, at: number, length: number): number {
    const shown = buf.subarray(at, Math.min(buf.length, at + length));
    this.errors.push(`unknown_command at ${this.offset + at}: ${hex(shown)}`);
    return 1; // skip the prefix byte and carry on, so later commands are still checked
  }

  /** An error after which the rest of the job can't be read: everything left is dropped. */
  private fatal(message: string, buf: Uint8Array, at: number): number {
    this.errors.push(`${message} at ${this.offset + at}`);
    return buf.length - at;
  }

  /** LF: prints the text line (if any) and moves down one line. */
  private flushText(lineFeed = false) {
    if (this.text.length > 0) {
      this.events.push({
        type: 'text',
        text: this.text,
        align: this.alignment,
        bold: this.emphasis,
      });
      this.drawText(this.text);
      this.text = '';
      this.advance(Math.max(this.spacing, CHAR_H));
    } else if (lineFeed) {
      this.advance(this.spacing);
    }
  }

  /** Each character as a box (filled when bold): readable enough to check layout; the report has the text. */
  private drawText(text: string) {
    const width = Math.min(text.length * CHAR_W, this.paperDots);
    const left =
      this.alignment === 'center'
        ? Math.floor((this.paperDots - width) / 2)
        : this.alignment === 'right'
          ? this.paperDots - width
          : 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === ' ') continue;
      const x0 = left + i * CHAR_W + 1;
      for (let dy = 2; dy < CHAR_H - 2; dy++) {
        for (let dx = 0; dx < CHAR_W - 2; dx++) {
          const edge = dy === 2 || dy === CHAR_H - 3 || dx === 0 || dx === CHAR_W - 3;
          if (this.emphasis || edge) this.set(x0 + dx, this.y + dy);
        }
      }
    }
  }

  private advance(dots: number) {
    if (dots > 0) this.row(this.y + dots - 1);
    this.y += dots;
  }

  private row(y: number): Uint8Array {
    while (this.rows.length <= y) this.rows.push(new Uint8Array(this.rowBytes));
    return this.rows[y]!;
  }

  private set(x: number, y: number) {
    if (x < 0 || x >= this.paperDots) return;
    this.row(y)[x >> 3]! |= 0x80 >> (x & 7);
  }

  private endPage(cut: boolean) {
    const height = this.rows.length;
    const bits = new Uint8Array(height * this.rowBytes);
    this.rows.forEach((row, i) => bits.set(row, i * this.rowBytes));
    if (height > 0 || cut)
      this.pages.push({ widthDots: this.paperDots, heightDots: height, bits, cut });
    this.rows = [];
    this.y = 0;
  }
}
