import { describe, expect, it, vi } from 'vitest';
import type { TenantContext, TenantTransactionClient } from '../tenancy';
import { OutboxPayloadInvalidError, OutboxService } from './outbox.service';

const tenantId = '0192f0b2-6c1a-7c3e-9a6f-1b2c3d4e5f60';
const scopeId = '0192f0b2-6c1a-7c3e-9a6f-1b2c3d4e5f61';

function setup() {
  const create = vi.fn().mockResolvedValue([{ id: 'event-1' }]);
  const tx = { $queryRaw: create } as unknown as TenantTransactionClient;
  const context = { require: () => ({ tenantId, userId: tenantId }) } as TenantContext;
  return { create, tx, outbox: new OutboxService(context) };
}

describe('OutboxService.add', () => {
  it('writes the current version with the context tenant', async () => {
    const { create, tx, outbox } = setup();
    const payload = { scope: 'organization', scopeId, key: 'platform.timezone' } as const;
    await expect(outbox.add(tx, { type: 'config.settings.changed', payload })).resolves.toBe(
      'event-1',
    );
    const [strings, ...values] = create.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toContain(
      'INSERT INTO outbox_events (tenant_id, type, version, payload)',
    );
    // ADR 0044 §5: the same statement wakes the worker, delivered only if the change commits.
    expect(strings.join('?')).toContain('pg_notify(?');
    expect(values).toEqual([
      tenantId,
      'config.settings.changed',
      1,
      JSON.stringify(payload),
      'durby_outbox',
    ]);
  });

  it('rejects a payload the schema rejects, without writing', async () => {
    const { create, tx, outbox } = setup();
    const bad = {
      type: 'config.settings.changed',
      payload: { scope: 'organization', scopeId, key: 'platform.timezone', value: 'UTC' },
    } as never;
    await expect(outbox.add(tx, bad)).rejects.toBeInstanceOf(OutboxPayloadInvalidError);
    expect(create).not.toHaveBeenCalled();
  });
});
