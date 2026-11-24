import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  productCategorySchema,
  stockLevelListResponseSchema,
  vendorInvoiceSchema,
  warehouseSchema,
} from '@durby/shared';
import request from 'supertest';
import type { App } from 'supertest/types';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { EntitlementsAdmin } from '../src/platform/config/entitlements';
import { withIdempotencyKey } from './support/idempotency';
import { RbacSeed, type SeededOrg } from './support/rbac';

/**
 * Correcting an approved vendor invoice line (ADR 0078): the corrected quantity and cost replace what was invoiced,
 * through a "correction" adjustment and a goods receipt; only approved invoices, only approvers, and only lines with
 * an existing item; the newest correction is the one that counts.
 */
describe('vendor invoice line corrections (ADR 0078)', () => {
  let app: INestApplication;
  let server: App;
  let seed: RbacSeed;
  let entitlements: EntitlementsAdmin;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication());
    await app.init();
    server = app.getHttpServer() as App;
    seed = new RbacSeed(app);
    entitlements = app.get(EntitlementsAdmin);
  });

  afterAll(async () => {
    await app.close();
  });

  async function member(org: SeededOrg, roleId: string, locations?: string[]) {
    const userId = await seed.user();
    await seed.member(org.id, userId, roleId, locations ? { locations } : {});
    return seed.token(userId, org.id);
  }

  const auth = (req: request.Test, token: string) => req.auth(token, { type: 'bearer' });
  const get = (token: string, path: string) => auth(request(server).get(`/api/v1${path}`), token);
  const send = (method: 'post' | 'put', token: string, path: string, body: object = {}) =>
    withIdempotencyKey(auth(request(server)[method](`/api/v1${path}`), token), uuidv7()).send(body);

  async function setup() {
    const org = await seed.org();
    await entitlements.setPlan(org.id, 'inventory', 'cli.entitlements');
    const owner = await member(org, org.roles.owner);
    const lager = await member(org, org.roles.warehouse, [org.locations[0]]);
    const warehouseId = warehouseSchema.parse(
      (
        await send('post', owner, '/inventory/warehouses', {
          locationId: org.locations[0],
          name: 'Main Warehouse',
        }).expect(201)
      ).body,
    ).id;
    const fish = productCategorySchema.parse(
      (await send('post', owner, '/catalog/categories', { name: 'Frozen fish' }).expect(201)).body,
    );
    const catfish = (
      (
        await send('post', owner, '/inventory/items', {
          name: 'Catfish 1 x 4kg',
          sku: '1103-002',
          unit: 'pc',
        }).expect(201)
      ).body as { id: string }
    ).id;
    const invoice = {
      warehouseId,
      supplier: 'Bonesca',
      invoiceNumber: '108666',
      invoiceDate: '10-11-2026',
      printedTotal: '1795.00',
      fileName: '108666.pdf',
      source: 'pdf',
      lines: [
        {
          code: '1103-002',
          description: 'Bigi Mama African Catfish 1 x 4kg',
          itemId: catfish,
          quantity: '50',
          unitCost: '11.00',
        },
        {
          code: '1971-002',
          description: 'OD Yellow Croakers 5 x 2kg',
          newItem: {
            name: 'OD Yellow Croakers 5 x 2kg',
            sku: '1971-002',
            unit: 'pc',
            categoryId: fish.id,
          },
          quantity: '30',
          unitCost: '41.50',
        },
      ],
    };
    return { org, owner, lager, warehouseId, catfish, invoice };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  /** Submitted and approved: the goods are in stock. */
  async function approved(s: Setup) {
    const pending = vendorInvoiceSchema.parse(
      (await send('post', s.lager, '/inventory/invoices', s.invoice).expect(201)).body,
    );
    return vendorInvoiceSchema.parse(
      (await send('post', s.owner, `/inventory/invoices/${pending.id}/approve`).expect(201)).body,
    );
  }

  const correct = (token: string, invoiceId: string, lineId: string, body: object) =>
    send('post', token, `/inventory/invoices/${invoiceId}/lines/${lineId}/corrections`, body);

  const stockOf = async (token: string, warehouseId: string) =>
    stockLevelListResponseSchema.parse(
      (await get(token, `/inventory/stock?warehouseId=${warehouseId}`).expect(200)).body,
    ).data;

  const catfishQuantity = async (s: Setup) =>
    (await stockOf(s.owner, s.warehouseId)).find((l) => l.itemName === 'Catfish 1 x 4kg')?.quantity;

  it('replaces a line’s quantity and cost by reversing entries, and the newest correction counts', async () => {
    const s = await setup();
    const invoice = await approved(s);
    const line = invoice.lines[0]!.id;
    expect(await catfishQuantity(s)).toBe('50.000');

    const corrected = vendorInvoiceSchema.parse(
      (
        await correct(s.owner, invoice.id, line, {
          quantity: '40',
          unitCost: '12.00',
          reason: 'Typed 50, delivered 40',
        }).expect(201)
      ).body,
    );
    expect(corrected.lines[0]).toMatchObject({
      quantity: '40.000',
      unitCost: '12.0000',
      value: '480.00',
    });
    // The invoice's own total is the sum of its corrected lines now.
    expect(corrected.total).toBe('1725.00');
    expect(corrected.printedTotal).toBe('1795.00');
    expect(await catfishQuantity(s)).toBe('40.000');

    // The second correction takes out what the first one put in (40), not what was invoiced (50).
    const again = vendorInvoiceSchema.parse(
      (
        await correct(s.owner, invoice.id, line, {
          quantity: '45',
          unitCost: '12.50',
          reason: 'Supplier sent 5 more',
        }).expect(201)
      ).body,
    );
    expect(again.lines[0]).toMatchObject({ quantity: '45.000', unitCost: '12.5000' });
    expect(await catfishQuantity(s)).toBe('45.000');
  });

  it('refuses lines without an existing item, unknown lines, pending invoices and other people', async () => {
    const s = await setup();
    const pending = vendorInvoiceSchema.parse(
      (await send('post', s.lager, '/inventory/invoices', s.invoice).expect(201)).body,
    );
    const body = { quantity: '40', unitCost: '12.00', reason: 'Typo' };
    await correct(s.owner, pending.id, pending.lines[0]!.id, body)
      .expect(409)
      .expect((res) =>
        expect((res.body as { code: string }).code).toBe('inventory.invoice_not_approved'),
      );

    const invoice = await approved(s);
    await correct(s.lager, invoice.id, invoice.lines[0]!.id, body).expect(403);
    await correct(s.owner, invoice.id, uuidv7(), body)
      .expect(404)
      .expect((res) =>
        expect((res.body as { code: string }).code).toBe('inventory.invoice_line_not_found'),
      );
    // The line of the new item: approval doesn't record its item, so it can't be corrected yet.
    await correct(s.owner, invoice.id, invoice.lines[1]!.id, body)
      .expect(409)
      .expect((res) =>
        expect((res.body as { code: string }).code).toBe('inventory.invoice_line_without_item'),
      );
    await correct(s.owner, invoice.id, invoice.lines[0]!.id, { ...body, quantity: '0' }).expect(
      400,
    );
    // Nothing was booked by the refusals.
    expect(await catfishQuantity(s)).toBe('50.000');
  });

  it('is refused when the goods it would take out have been sold or wasted, and books nothing', async () => {
    const s = await setup();
    const invoice = await approved(s);
    await send('post', s.owner, '/inventory/adjustments', {
      warehouseId: s.warehouseId,
      reason: 'waste',
      lines: [{ itemId: s.catfish, quantity: '-45' }],
    }).expect(201);
    expect(await catfishQuantity(s)).toBe('5.000');

    // Correcting to 40 would take 50 out, and only 5 are left.
    await correct(s.owner, invoice.id, invoice.lines[0]!.id, {
      quantity: '40',
      unitCost: '12.00',
      reason: 'Typed 50, delivered 40',
    })
      .expect(409)
      .expect((res) =>
        expect((res.body as { code: string }).code).toBe('inventory.insufficient_stock'),
      );
    expect(await catfishQuantity(s)).toBe('5.000');
    const after = vendorInvoiceSchema.parse(
      (await get(s.owner, `/inventory/invoices/${invoice.id}`).expect(200)).body,
    );
    expect(after.lines[0]).toMatchObject({ quantity: '50.000', unitCost: '11.0000' });
  });

  it('is not visible across organizations', async () => {
    const a = await setup();
    const b = await setup();
    const invoice = await approved(a);
    await correct(b.owner, invoice.id, invoice.lines[0]!.id, {
      quantity: '40',
      unitCost: '12.00',
      reason: 'Typo',
    }).expect(404);
  });
});
