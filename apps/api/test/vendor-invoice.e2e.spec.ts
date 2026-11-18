import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  productCategorySchema,
  stockItemListResponseSchema,
  stockLevelListResponseSchema,
  vendorInvoiceListResponseSchema,
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
 * Vendor invoices waiting for approval (ADR 0054): submitting books nothing; approval books one goods receipt with the
 * new items, once; rejecting needs a reason; only approvers at the warehouse decide.
 */
describe('vendor invoice approval queue (ADR 0054)', () => {
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
    return { org, owner, lager, warehouseId, fish, catfish, invoice };
  }

  const stockOf = async (token: string, warehouseId: string) =>
    stockLevelListResponseSchema.parse(
      (await get(token, `/inventory/stock?warehouseId=${warehouseId}`).expect(200)).body,
    ).data;

  it('waits as pending, then books one receipt with the new item when approved', async () => {
    const s = await setup();
    const pending = vendorInvoiceSchema.parse(
      (await send('post', s.lager, '/inventory/invoices', s.invoice).expect(201)).body,
    );
    expect(pending).toMatchObject({
      status: 'pending',
      lineCount: 2,
      newItemCount: 1,
      total: '1795.00',
      printedTotal: '1795.00',
      documentId: null,
    });
    expect(pending.number).toMatch(/^VIN-\d{4}-\d{6}$/);
    // Nothing in stock yet.
    expect(await stockOf(s.owner, s.warehouseId)).toEqual([]);

    // The warehouse worker submits but can't approve.
    await send('post', s.lager, `/inventory/invoices/${pending.id}/approve`).expect(403);
    const approved = vendorInvoiceSchema.parse(
      (await send('post', s.owner, `/inventory/invoices/${pending.id}/approve`).expect(201)).body,
    );
    expect(approved.status).toBe('approved');
    expect(approved.documentNumber).toMatch(/^GR-/);
    const levels = await stockOf(s.owner, s.warehouseId);
    expect(levels.map((l) => [l.itemName, l.quantity]).sort()).toEqual([
      ['Catfish 1 x 4kg', '50.000'],
      ['OD Yellow Croakers 5 x 2kg', '30.000'],
    ]);
    const items = stockItemListResponseSchema.parse(
      (await get(s.owner, '/inventory/items').expect(200)).body,
    ).data;
    expect(items.find((i) => i.sku === '1971-002')).toMatchObject({ categoryId: s.fish.id });

    // Once only.
    await send('post', s.owner, `/inventory/invoices/${pending.id}/approve`)
      .expect(409)
      .expect((res) =>
        expect((res.body as { code: string }).code).toBe('inventory.vendor_invoice_decided'),
      );
  });

  /** ADR 0055: a line invoiced per carton is booked in pieces; a new item keeps its brand and pack size. */
  it('converts lines invoiced in a unit of measurement and keeps the new item’s pack size', async () => {
    const s = await setup();
    const carton = (
      (
        await send('post', s.owner, '/inventory/units', {
          name: 'Carton',
          symbol: 'CTN',
          baseUnit: 'pc',
          factor: '12',
        }).expect(201)
      ).body as { id: string }
    ).id;
    const kgCarton = (
      (
        await send('post', s.owner, '/inventory/units', {
          name: 'Sack',
          symbol: 'SK',
          baseUnit: 'kg',
          factor: '25',
        }).expect(201)
      ).body as { id: string }
    ).id;
    const [catfishLine, croakerLine] = s.invoice.lines;
    const body = {
      ...s.invoice,
      lines: [
        {
          ...catfishLine,
          quantity: '2',
          unitCost: '132.00',
          unitId: carton,
          // The matched product gets its category and pack size on approval (ADR 0055).
          itemDetails: { categoryId: s.fish.id, packCount: 1, packSize: '4', packUnit: 'kg' },
        },
        {
          ...croakerLine,
          newItem: {
            ...croakerLine!.newItem!,
            brand: 'OD',
            packCount: 5,
            packSize: '2',
            packUnit: 'kg',
          },
        },
      ],
    };
    // A unit of another base unit than the item's is refused.
    await send('post', s.lager, '/inventory/invoices', {
      ...body,
      lines: [{ ...body.lines[0], unitId: kgCarton }, body.lines[1]],
    })
      .expect(400)
      .expect((res) => expect((res.body as { code: string }).code).toBe('inventory.unit_mismatch'));

    const pending = vendorInvoiceSchema.parse(
      (await send('post', s.lager, '/inventory/invoices', body).expect(201)).body,
    );
    expect(pending.lines[0]).toMatchObject({
      unitId: carton,
      unitSymbol: 'CTN',
      quantity: '2.000',
      itemDetails: {
        categoryId: s.fish.id,
        brand: null,
        packCount: 1,
        packSize: '4.000',
        packUnit: 'kg',
      },
    });
    expect(pending.lines[1]?.newItem).toMatchObject({
      brand: 'OD',
      packCount: 5,
      packSize: '2.000',
      packUnit: 'kg',
    });

    await send('post', s.owner, `/inventory/invoices/${pending.id}/approve`).expect(201);
    const levels = await stockOf(s.owner, s.warehouseId);
    // 2 cartons of 12 at 132.00 a carton: 24 pieces at 11.00.
    expect(levels.find((l) => l.itemName === 'Catfish 1 x 4kg')).toMatchObject({
      quantity: '24.000',
    });
    const items = stockItemListResponseSchema.parse(
      (await get(s.owner, '/inventory/items').expect(200)).body,
    ).data;
    expect(items.find((i) => i.sku === '1971-002')).toMatchObject({
      brand: 'OD',
      packCount: 5,
      packSize: '2.000',
      packUnit: 'kg',
    });
    expect(items.find((i) => i.id === s.catfish)).toMatchObject({
      categoryId: s.fish.id,
      brand: null,
      packCount: 1,
      packSize: '4.000',
      packUnit: 'kg',
    });
  });

  it('can be changed while pending, and rejected with a reason', async () => {
    const s = await setup();
    const pending = vendorInvoiceSchema.parse(
      (await send('post', s.lager, '/inventory/invoices', s.invoice).expect(201)).body,
    );
    const changed = vendorInvoiceSchema.parse(
      (
        await send('put', s.lager, `/inventory/invoices/${pending.id}`, {
          ...s.invoice,
          lines: [s.invoice.lines[0]],
        }).expect(200)
      ).body,
    );
    expect(changed.lineCount).toBe(1);
    await send('post', s.owner, `/inventory/invoices/${pending.id}/reject`, {}).expect(400);
    const rejected = vendorInvoiceSchema.parse(
      (
        await send('post', s.owner, `/inventory/invoices/${pending.id}/reject`, {
          reason: 'Wrong warehouse',
        }).expect(201)
      ).body,
    );
    expect(rejected).toMatchObject({ status: 'rejected', rejectReason: 'Wrong warehouse' });
    await send('put', s.lager, `/inventory/invoices/${pending.id}`, s.invoice).expect(409);
    const list = vendorInvoiceListResponseSchema.parse(
      (await get(s.owner, '/inventory/invoices?status=rejected').expect(200)).body,
    ).data;
    expect(list.map((i) => i.id)).toContain(pending.id);
  });

  it('is not visible across organizations', async () => {
    const a = await setup();
    const b = await setup();
    const pending = vendorInvoiceSchema.parse(
      (await send('post', a.owner, '/inventory/invoices', a.invoice).expect(201)).body,
    );
    await get(b.owner, `/inventory/invoices/${pending.id}`).expect(404);
  });
});
