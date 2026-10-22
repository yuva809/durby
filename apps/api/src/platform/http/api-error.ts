import { HttpException } from '@nestjs/common';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * An error with a stable `code` (CLAUDE.md conventions). `message` is a developer-facing fallback;
 * clients show the label for `code`. Headers (e.g. Retry-After) are set by the exception filter.
 */
export class ApiError extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super({ code, message, ...(details === undefined ? {} : { details }) }, status);
    this.name = 'ApiError';
  }

  body(): ApiErrorBody {
    return this.getResponse() as ApiErrorBody;
  }
}
