import { describe, expect, it } from 'vitest';
import { formatSplitReport, parseRbacSplitArgs } from './rbac-split';

describe('rbac:split (ADR 0051)', () => {
  it('reports a change and fails the dry run when something would be lost', () => {
    const line = {
      organizationId: 'o',
      kind: 'membership' as const,
      id: 'm',
      role: 'manager',
      adds: ['deny platform.users.edit'],
      unchanged: true,
      lost: [],
      gained: [],
    };
    expect(formatSplitReport([line])).toMatchObject({ ok: true });
    expect(formatSplitReport([{ ...line, unchanged: false, lost: ['x'] }]).ok).toBe(false);
    expect(formatSplitReport([]).text).toContain('summary: 0 roles, members or invitations');
  });

  it('runs only as a dry run', () => {
    expect(parseRbacSplitArgs(['--dry-run'])).toEqual({ dryRun: true });
    expect(() => parseRbacSplitArgs([])).toThrow(/Usage/);
  });
});
