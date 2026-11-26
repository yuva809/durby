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
      'INSERT INTO outbox_events (tenant_id, type, version, payload, available_at)',
    );
    // ADR 0044 §5: the same statement wakes the worker, delivered only if the change commits.
    expect(strings.join('?')).toContain('pg_notify(?');
    // No availableAt: due at once (the database's now()).
    expect(values).toEqual([
      tenantId,
      'config.settings.changed',
      1,
      JSON.stringify(payload),
      null,
      'durby_outbox',
    ]);
  });

  it('writes a later due time, never earlier than the database clock (R2.0)', async () => {
    const { create, tx, outbox } = setup();
    const payload = { scope: 'organization', scopeId, key: 'platform.timezone' } as const;
    const at = new Date(Date.now() + 24 * 3_600_000);
    await outbox.add(tx, { type: 'config.settings.changed', payload }, { availableAt: at });
    const [strings, ...values] = create.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join('?')).toContain('GREATEST(now(), COALESCE(?::timestamptz, now()))');
    expect(values).toContain(at);
  });

  it('refuses a due time more than 400 days ahead, without writing', async () => {
    const { create, tx, outbox } = setup();
    const payload = { scope: 'organization', scopeId, key: 'platform.timezone' } as const;
    const tooFar = new Date(Date.now() + 401 * 24 * 3_600_000);
    await expect(
      outbox.add(tx, { type: 'config.settings.changed', payload }, { availableAt: tooFar }),
    ).rejects.toBeInstanceOf(OutboxPayloadInvalidError);
    await expect(
      outbox.add(tx, { type: 'config.settings.changed', payload }, { availableAt: new Date(NaN) }),
    ).rejects.toBeInstanceOf(OutboxPayloadInvalidError);
    expect(create).not.toHaveBeenCalled();
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
