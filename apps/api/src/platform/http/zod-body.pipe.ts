import { HttpStatus, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiError } from './api-error';

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * Validates a request body with a Zod schema: `@Body(new ZodBody(loginRequestSchema))`.
 * Failures are 400 `validation.failed` with path/code/message per issue, never the input values
 * (bodies carry passwords and tokens).
 */
export class ZodBody<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      code: issue.code,
      message: issue.message,
    }));
    throw new ApiError(HttpStatus.BAD_REQUEST, 'validation.failed', 'Invalid request body.', {
      issues,
    });
  }
}
