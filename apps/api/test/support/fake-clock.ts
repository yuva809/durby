import { Clock } from '../../src/platform/auth/clock';

/** A Clock that stands still until moved. */
export class FakeClock extends Clock {
  constructor(private current = new Date('2026-10-22T12:00:00Z')) {
    super();
  }

  override now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  set(date: Date): void {
    this.current = new Date(date);
  }
}
