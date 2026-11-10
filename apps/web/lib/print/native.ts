import {
  type NativeAppFeature,
  type NativeDeviceSettings,
  nativeDeviceSettingsAnswerSchema,
  type NativeInstallResult,
  nativeInstallUpdateAnswerSchema,
  type NativeUpdateAnswer,
  nativeUpdateAnswerSchema,
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
  /** App 1.1 (`nothingPrinted`): the job failed before any of its bytes left the device. */
  nothingPrinted?: boolean;
}

/** This device's settings as the app stored them; `refused`: the write broke the schema and stored nothing. */
export interface NativeDeviceSettingsOutcome {
  settings: NativeDeviceSettings;
  refused: boolean;
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

export const NATIVE_TIMEOUTS = {
  info: 3_000,
  print: 30_000,
  discover: 20_000,
  settings: 3_000,
  /** Reading latest.json from the server. */
  update: 15_000,
  /** Downloading and checking the APK (a few MB). */
  install: 180_000,
};

export class NativePrinter {
  private readonly infoWaiters: ((answer: NativeInfoAnswer | null) => void)[] = [];
  private readonly discoverWaiters: ((answer: NativeDiscoverAnswer | null) => void)[] = [];
  private readonly printWaiters = new Map<string, (outcome: NativePrintOutcome) => void>();
  private readonly settingsWaiters: ((answer: NativeDeviceSettingsOutcome | null) => void)[] = [];
  private readonly updateWaiters: ((answer: NativeUpdateAnswer | null) => void)[] = [];
  private readonly installWaiters: ((answer: NativeInstallResult | null) => void)[] = [];
  private featureSet: Promise<ReadonlySet<string>> | null = null;

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

  /**
   * What this app can do (`NATIVE_APP_FEATURES`), asked once per page. Version 1.0 names none; an app that doesn't
   * answer counts as none (asked again next time).
   */
  features(): Promise<ReadonlySet<string>> {
    this.featureSet ??= this.info().then((answer) => {
      if (!answer) this.featureSet = null;
      return new Set(answer?.features ?? []);
    });
    return this.featureSet;
  }

  async has(feature: NativeAppFeature): Promise<boolean> {
    return (await this.features()).has(feature);
  }

  /** This device's stored settings; null if the app doesn't answer. Only for apps with `deviceSettings`. */
  deviceSettings(): Promise<NativeDeviceSettingsOutcome | null> {
    return this.ask(this.settingsWaiters, 'deviceSettings', this.timeouts.settings);
  }

  /** Stores this device's settings and answers what is stored now; null if the app doesn't answer. */
  setDeviceSettings(settings: NativeDeviceSettings): Promise<NativeDeviceSettingsOutcome | null> {
    return this.ask(this.settingsWaiters, 'setDeviceSettings', this.timeouts.settings, {
      settings,
    });
  }

  /** A newer app version on the server, or null (none, or no answer). Only for apps with `update`; never installs. */
  async checkUpdate(): Promise<NativeUpdateAnswer['available']> {
    return (await this.ask(this.updateWaiters, 'update', this.timeouts.update))?.available ?? null;
  }

  /** Downloads, checks and hands the update to Android's installer, which asks the user; null if no answer. */
  installUpdate(): Promise<NativeInstallResult | null> {
    return this.ask(this.installWaiters, 'installUpdate', this.timeouts.install);
  }

  /** Printers on the device's own network; null if the app doesn't answer. */
  discover(): Promise<NativeDiscoverAnswer | null> {
    return this.ask(this.discoverWaiters, 'discover', this.timeouts.discover);
  }

  private ask<T>(
    waiters: ((answer: T | null) => void)[],
    type: string,
    ms: number,
    extra: object = {},
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
      this.target.postMessage(JSON.stringify({ version: NATIVE_PRINT_PROTOCOL, type, ...extra }));
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
    const update = nativeUpdateAnswerSchema.safeParse(message);
    if (update.success) {
      this.updateWaiters.shift()?.(update.data);
      return;
    }
    const install = nativeInstallUpdateAnswerSchema.safeParse(message);
    if (install.success) {
      this.installWaiters.shift()?.(install.data.result);
      return;
    }
    const settings = nativeDeviceSettingsAnswerSchema.safeParse(message);
    if (settings.success) {
      this.settingsWaiters.shift()?.({
        settings: settings.data.settings,
        refused: settings.data.refused ?? false,
      });
      return;
    }
    const answer = nativePrintAnswerSchema.safeParse(message);
    if (answer.success) {
      this.printWaiters.get(answer.data.jobId)?.({
        state: answer.data.state,
        code: answer.data.code,
        ...(answer.data.nothingPrinted && { nothingPrinted: true }),
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
