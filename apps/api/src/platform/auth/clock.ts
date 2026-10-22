import { Injectable } from '@nestjs/common';

/** Current time, injectable so tests can move it (lockout windows, token expiry). */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}
