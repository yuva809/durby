import { describe, expect, it } from 'vitest';
import {
  AUDIT_ACTION_KEYS,
  AUDIT_ACTION_PATTERN,
  AUDIT_ACTIONS,
  AUDIT_ENTITY_TYPES,
  AUDIT_SYSTEM_ACTOR_KEYS,
  AUDIT_SYSTEM_ACTORS,
  isAuditAction,
} from './audit';

const LABEL_KEY = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

describe('audit action registry', () => {
  it('uses module.entity.past_tense keys that pass the SQL shape check', () => {
    for (const key of AUDIT_ACTION_KEYS) {
      expect(key).toMatch(AUDIT_ACTION_PATTERN);
      expect(AUDIT_ACTIONS[key].label).toMatch(LABEL_KEY);
    }
  });

  it('maps every action to a registered entity type', () => {
    for (const key of AUDIT_ACTION_KEYS) {
      expect(AUDIT_ENTITY_TYPES).toContain(AUDIT_ACTIONS[key].entityType);
    }
  });

  it('allows longer keys in the shape check, so later phases need no constraint migration', () => {
    expect('billing.invoice.line.added').toMatch(AUDIT_ACTION_PATTERN);
    expect('platform.role').not.toMatch(AUDIT_ACTION_PATTERN);
    expect('Platform.role.created').not.toMatch(AUDIT_ACTION_PATTERN);
  });

  it('recognizes registered keys only', () => {
    expect(isAuditAction('platform.role.updated')).toBe(true);
    expect(isAuditAction('platform.role.renamed')).toBe(false);
    expect(isAuditAction('toString')).toBe(false);
  });
});

describe('audit system actors', () => {
  it('have dotted keys and a label key', () => {
    for (const key of AUDIT_SYSTEM_ACTOR_KEYS) {
      expect(key).toMatch(/^[a-z]+(\.[a-z_]+)*$/);
      expect(AUDIT_SYSTEM_ACTORS[key].label).toMatch(LABEL_KEY);
    }
  });
});
