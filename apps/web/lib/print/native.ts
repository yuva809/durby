import {
  NATIVE_PRINT_OBJECT,
  NATIVE_PRINT_PROTOCOL,
  nativeDiscoverAnswerSchema,
  nativeInfoAnswerSchema,
  nativePrintAnswerSchema,
  type NativeDiscoverAnswer,
  type NativeInfoAnswer,
  type NativePrintCode,
  type PrinterSettings,
  type PrintImage,
} from '@durby/shared';

/**
 * Talking to the Durby Android app (ADR 0032). The app adds `window.durbyPrint` to allow-listed pages only
 * (`addWebMessageListener`); outside the app it doesn't exist and printing stays `window.print()`.
 */

type MessageListener = (event: { data: unknown }) => void;

export interface NativePrintObject {
  postMessage(message: string): void;
  addEventListener(type: 'message', listener: MessageListener): void;
}

/** What the web shows after a print: the app's answer, or `print.no_answer` when the app stayed silent. */
export interface NativePrintOutcome {
  state: 'sent' | 'failed';
  code: NativePrintCode | 'print.no_answer';
}

export function findNativePrintObject(scope: object = globalThis): NativePrintObject | null {
  const candidate = (scope as Record<string, unknown>)[NATIVE_PRINT_OBJECT] as
    Partial<NativePrintObject> | undefined;
  return candidate &&
    typeof candidate.postMessage === 'function' &&
    typeof candidate.addEventListener === 'function'
    ? (candidate as NativePrintObject)
    : null;
}

export const NATIVE_TIMEOUTS = { info: 3_000, print: 30_000, discover: 20_000 };

export class NativePrinter {
  private readonly infoWaiters: ((answer: NativeInfoAnswer | null) => void)[] = [];
  private readonly discoverWaiters: ((answer: NativeDiscoverAnswer | null) => void)[] = [];
  private readonly printWaiters = new Map<string, (outcome: NativePrintOutcome) => void>();

  constructor(
    private readonly target: NativePrintObject,
    private readonly timeouts = NATIVE_TIMEOUTS,
  ) {
    target.addEventListener('message', (event) => this.receive(event.data));
  }

  /** The app's version; null if the app doesn't answer. */
  info(): Promise<NativeInfoAnswer | null> {
    return this.ask(this.infoWaiters, 'info', this.timeouts.info);
  }

  /** Printers on the device's own network; null if the app doesn't answer. */
  discover(): Promise<NativeDiscoverAnswer | null> {
    return this.ask(this.discoverWaiters, 'discover', this.timeouts.discover);
  }

  private ask<T>(
    waiters: ((answer: T | null) => void)[],
    type: string,
    ms: number,
  ): Promise<T | null> {
    return new Promise((resolve) => {
      const waiter = (answer: T | null) => {
        clearTimeout(timer);
        resolve(answer);
      };
      const timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, ms);
      waiters.push(waiter);
      this.target.postMessage(JSON.stringify({ version: NATIVE_PRINT_PROTOCOL, type }));
    });
  }

  /** Sends one picture to `printer`. The same `jobId` (Retry) never prints twice once it was sent. */
  print(jobId: string, image: PrintImage, printer: PrinterSettings): Promise<NativePrintOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.printWaiters.delete(jobId);
        resolve({ state: 'failed', code: 'print.no_answer' });
      }, this.timeouts.print);
      this.printWaiters.set(jobId, (outcome) => {
        clearTimeout(timer);
        this.printWaiters.delete(jobId);
        resolve(outcome);
      });
      this.target.postMessage(
        JSON.stringify({ version: NATIVE_PRINT_PROTOCOL, type: 'print', jobId, image, printer }),
      );
    });
  }

  private receive(data: unknown) {
    let message: unknown;
    try {
      message = typeof data === 'string' ? JSON.parse(data) : data;
    } catch {
      return;
    }
    const info = nativeInfoAnswerSchema.safeParse(message);
    if (info.success) {
      this.infoWaiters.shift()?.(info.data);
      return;
    }
    const found = nativeDiscoverAnswerSchema.safeParse(message);
    if (found.success) {
      this.discoverWaiters.shift()?.(found.data);
      return;
    }
    const answer = nativePrintAnswerSchema.safeParse(message);
    if (answer.success) {
      this.printWaiters.get(answer.data.jobId)?.({
        state: answer.data.state,
        code: answer.data.code,
      });
      return;
    }
    // The app could not read a print request at all (no job id in its answer): it was the oldest one.
    const failed = message as { type?: unknown; jobId?: unknown; code?: unknown } | null;
    if (
      failed?.type === 'print' &&
      failed.jobId === null &&
      failed.code === 'print.payload_invalid'
    ) {
      const first = this.printWaiters.values().next();
      if (!first.done) first.value({ state: 'failed', code: 'print.payload_invalid' });
    }
  }
}

let shared: NativePrinter | null | undefined;

/** The app's printer on this page, or null outside the app. One listener per page. */
export function nativePrinter(): NativePrinter | null {
  if (shared === undefined) {
    const target = typeof window === 'undefined' ? null : findNativePrintObject(window);
    shared = target ? new NativePrinter(target) : null;
  }
  return shared;
}
