import { z } from 'zod';

/** PATCH /api/v1/organization (docs/platform/web-shell.md → Organization profile). */

export const ORGANIZATION_NAME_MAX_LENGTH = 100;

export const updateOrganizationRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(ORGANIZATION_NAME_MAX_LENGTH),
});

export const organizationSchema = z.object({ id: z.uuid(), name: z.string() });

export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;
export type Organization = z.infer<typeof organizationSchema>;
