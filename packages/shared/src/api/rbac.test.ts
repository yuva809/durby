import { describe, expect, it } from 'vitest';
import {
  createRoleRequestSchema,
  updateMemberRequestSchema,
  updateRoleRequestSchema,
} from './rbac';

describe('rbac schemas', () => {
  it('trims role names and bounds their length', () => {
    expect(createRoleRequestSchema.parse({ name: '  Shift lead ', permissions: [] }).name).toBe(
      'Shift lead',
    );
    expect(createRoleRequestSchema.safeParse({ name: '   ', permissions: [] }).success).toBe(false);
    expect(
      createRoleRequestSchema.safeParse({ name: 'x'.repeat(101), permissions: [] }).success,
    ).toBe(false);
  });

  it('requires something to update', () => {
    expect(updateRoleRequestSchema.safeParse({}).success).toBe(false);
    expect(updateMemberRequestSchema.safeParse({}).success).toBe(false);
    expect(updateMemberRequestSchema.safeParse({ locationIds: null }).success).toBe(true);
  });

  it('takes location ids as uuids, null meaning all locations', () => {
    expect(updateMemberRequestSchema.safeParse({ locationIds: ['nope'] }).success).toBe(false);
    expect(
      updateMemberRequestSchema.safeParse({ locationIds: ['01a165d1-ff82-7d5e-8d25-abf61bd10091'] })
        .success,
    ).toBe(true);
  });
});
