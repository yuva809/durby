import { z } from 'zod';

/**
 * Feedback to the Durby team (docs/platform/feedback.md, ADR 0044 step 5): staff of a customer send a bug, an idea or a
 * question from the app; Durby staff read it in the admin portal and mark it seen or done. Platform data (the
 * operator's support inbox), not tenant data: an organization only adds feedback and reads its own.
 */

export const FEEDBACK_CATEGORIES = ['bug', 'idea', 'question'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_STATUSES = ['new', 'seen', 'done'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_MESSAGE_MAX_LENGTH = 2000;

export const sendFeedbackRequestSchema = z.strictObject({
  category: z.enum(FEEDBACK_CATEGORIES),
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX_LENGTH),
  /** The page it is about (`/orders`), a same-origin path. */
  pagePath: z
    .string()
    .max(200)
    .regex(/^\/[^\s]*$/)
    .optional(),
});

export const feedbackSchema = z.object({
  id: z.uuid(),
  category: z.enum(FEEDBACK_CATEGORIES),
  message: z.string(),
  pagePath: z.string().nullable(),
  status: z.enum(FEEDBACK_STATUSES),
  createdAt: z.iso.datetime(),
});

export const feedbackListResponseSchema = z.object({ data: z.array(feedbackSchema) });

/** The admin portal's view: who sent it, from which customer. */
export const staffFeedbackSchema = feedbackSchema.extend({
  organizationId: z.uuid(),
  organizationName: z.string(),
  /** null when the user no longer exists. */
  userEmail: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export const staffFeedbackListQuerySchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
});

export const staffFeedbackListResponseSchema = z.object({ data: z.array(staffFeedbackSchema) });

export const updateFeedbackStatusRequestSchema = z.strictObject({
  status: z.enum(FEEDBACK_STATUSES),
});

export type SendFeedbackRequest = z.infer<typeof sendFeedbackRequestSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
export type StaffFeedback = z.infer<typeof staffFeedbackSchema>;
export type StaffFeedbackListQuery = z.infer<typeof staffFeedbackListQuerySchema>;
export type StaffFeedbackListResponse = z.infer<typeof staffFeedbackListResponseSchema>;
export type UpdateFeedbackStatusRequest = z.infer<typeof updateFeedbackStatusRequestSchema>;

/** How many of an organization's own feedback items the app lists (newest first). */
export const FEEDBACK_OWN_LIST_LIMIT = 50;
/** How many the admin portal lists per status (newest first). */
export const FEEDBACK_STAFF_LIST_LIMIT = 200;
