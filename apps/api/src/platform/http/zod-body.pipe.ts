import { HttpStatus, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ApiError } from './api-error';

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

/** Path, code and message per issue: never the input values (bodies carry passwords and tokens). */
export function issuesOf(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
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
    throw new ApiError(HttpStatus.BAD_REQUEST, 'validation.failed', 'Invalid request body.', {
      issues: issuesOf(result.error),
    });
  }
}

/** The same for the query string: `@Query(new ZodQuery(auditLogQuerySchema))`. */
export class ZodQuery<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    throw new ApiError(HttpStatus.BAD_REQUEST, 'validation.failed', 'Invalid query.', {
      issues: issuesOf(result.error),
    });
  }
}
