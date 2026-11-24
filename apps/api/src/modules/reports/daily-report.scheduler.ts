import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { DailyReport } from './daily-report.service';

const EVERY_MS = 5 * 60_000;
const FIRST_MS = 30_000;

/** Looks for due daily reports (ADR 0083). Started in the worker process only (src/worker.ts). */
@Injectable()
export class DailyReportScheduler implements OnApplicationShutdown {
  private readonly logger = new Logger(DailyReportScheduler.name);
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(private readonly report: DailyReport) {}

  start(): void {
    this.next(FIRST_MS);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** The next pass starts after the last one ended: passes never overlap. */
  private next(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.pass().finally(() => this.next(EVERY_MS));
    }, ms);
  }

  private async pass(): Promise<void> {
    try {
      const counts = await this.report.sendDue();
      if (counts.sent > 0 || counts.failed > 0) {
        this.logger.log({ event: 'reports.daily', ...counts }, 'reports.daily');
      }
    } catch (error) {
      this.logger.error(
        { event: 'reports.daily_error', error: error instanceof Error ? error.message : 'unknown' },
        'reports.daily_error',
      );
    }
  }
}
