import { Controller, Get, Post } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { listIdempotencyRoutes, type IdempotencyRouteInfo } from '../src/platform/idempotency';
import { listRoutes, RequirePermission, type RouteInfo } from '../src/platform/rbac';

async function routesOf(): Promise<{ access: RouteInfo[]; idempotency: IdempotencyRouteInfo[] }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  await moduleRef.init();
  try {
    const deps = [
      moduleRef.get(DiscoveryService),
      moduleRef.get(MetadataScanner),
      moduleRef.get(Reflector),
    ] as const;
    return { access: listRoutes(...deps), idempotency: listIdempotencyRoutes(...deps) };
  } finally {
    await moduleRef.close();
  }
}

const withMarker = (routes: RouteInfo[], kind: string): string[] =>
  routes.filter((r) => r.markers.some((m) => m.kind === kind)).map((r) => r.route);

/**
 * CLAUDE.md rule 10 / ADR 0006: @Authenticated() is only for user-level routes that never touch
 * tenant data. A new one changes this list and needs review in the PR. Public routes are listed
 * for the same reason.
 */
describe('route markers', () => {
  let routes: RouteInfo[];
  let idempotency: IdempotencyRouteInfo[];

  beforeAll(async () => {
    ({ access: routes, idempotency } = await routesOf());
  });

  it('lists every @Authenticated() route', () => {
    expect(withMarker(routes, 'authenticated')).toEqual([
      'GET /api/v1/auth/me',
      // ADR 0009 §6: reads only the token's active organization's features, for a member.
      'GET /api/v1/me/entitlements',
      // The caller's own language: the users row only, no tenant data.
      'PATCH /api/v1/auth/me',
      // ADR 0023 §3: the caller's own password (and the forced change of a temporary one).
      'POST /api/v1/auth/password/change',
      'POST /api/v1/auth/switch-organization',
      // ADR 0007: writes only the caller's own membership, in the tenant the invitation proves.
      'POST /api/v1/invitations/accept-signed-in',
    ]);
  });

  it('lists every @Public() route', () => {
    expect(withMarker(routes, 'public')).toEqual([
      'GET /api/v1/health',
      'GET /api/v1/health/live',
      // ADR 0026: the table's menu, authenticated by nothing but its QR link; reads only.
      'GET /api/v1/public/menu/:token',
      // ADR 0015 §3: the partner theme for the request's host; no tenant data.
      'GET /api/v1/theme',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/password/forgot',
      'POST /api/v1/auth/password/reset',
      'POST /api/v1/auth/refresh',
      'POST /api/v1/auth/verify-email',
      'POST /api/v1/auth/verify-email/resend',
      // ADR 0007: authenticated by the single-use invitation token.
      'POST /api/v1/invitations/accept',
      'POST /api/v1/invitations/preview',
      // ADR 0017: staff sign-in, authenticated by the password, the invitation token or the staff
      // session cookie.
      'POST /api/v1/platform/auth/accept',
      'POST /api/v1/platform/auth/login',
      'POST /api/v1/platform/auth/logout',
    ]);
  });

  /** ADR 0017: every staff route with its staff key; a new one is a reviewable diff. */
  it('lists every @PlatformOnly() route with its staff key', () => {
    expect(
      routes.flatMap((r) =>
        r.markers.flatMap((m) =>
          m.kind === 'platformOnly' ? [`${r.route} ${m.key}${m.fresh ? ' (fresh)' : ''}`] : [],
        ),
      ),
    ).toEqual([
      'GET /api/v1/platform/audit staff.audit.read',
      'GET /api/v1/platform/auth/me staff.portal.access',
      'GET /api/v1/platform/customers staff.customers.read',
      'GET /api/v1/platform/customers/:id staff.customers.read',
      'GET /api/v1/platform/onboarding-options staff.customers.create',
      'GET /api/v1/platform/staff staff.staff.read',
      'PATCH /api/v1/platform/staff/:id staff.staff.manage (fresh)',
      'POST /api/v1/platform/auth/reauth staff.portal.access',
      'POST /api/v1/platform/customers staff.customers.create (fresh)',
      'POST /api/v1/platform/customers/:id/owner-invite staff.customers.invite (fresh)',
      'POST /api/v1/platform/staff/:id/deactivate staff.staff.manage (fresh)',
      'POST /api/v1/platform/staff/invitations staff.staff.manage (fresh)',
    ]);
  });

  it('gives every route exactly one marker (the startup check passes)', () => {
    expect(routes.filter((r) => r.markers.length !== 1)).toEqual([]);
  });

  it('refuses to boot the api when a route has no marker', async () => {
    @Controller('forgotten')
    class ForgottenController {
      @Get()
      list(): void {}
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ForgottenController],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await expect(app.init()).rejects.toThrow('GET /api/v1/forgotten: no access marker');
    await app.close();
  });

  /** CLAUDE.md rule 8 / ADR 0014: a new exempt write route changes this list and needs review. */
  it('lists every @IdempotencyExempt() write route', () => {
    expect(idempotency.filter((r) => r.exempt !== undefined).map((r) => r.route)).toEqual([
      // Sets one value on the caller's own users row (no tenant for the idempotency store).
      'PATCH /api/v1/auth/me',
      'PATCH /api/v1/platform/staff/:id',
      'POST /api/v1/auth/login',
      'POST /api/v1/auth/logout',
      'POST /api/v1/auth/password/change',
      'POST /api/v1/auth/password/forgot',
      'POST /api/v1/auth/password/reset',
      'POST /api/v1/auth/refresh',
      'POST /api/v1/auth/switch-organization',
      'POST /api/v1/auth/verify-email',
      'POST /api/v1/auth/verify-email/resend',
      'POST /api/v1/invitations/:id/link',
      'POST /api/v1/invitations/accept',
      'POST /api/v1/invitations/accept-signed-in',
      'POST /api/v1/invitations/preview',
      'POST /api/v1/platform/auth/accept',
      'POST /api/v1/platform/auth/login',
      'POST /api/v1/platform/auth/logout',
      'POST /api/v1/platform/auth/reauth',
      // ADR 0017 §8: onboarding replays through the staff store; resending changes no data.
      'POST /api/v1/platform/customers',
      'POST /api/v1/platform/customers/:id/owner-invite',
      // ADR 0017 §8 (with PATCH /platform/staff/:id above): replay-safe set-state staff writes.
      'POST /api/v1/platform/staff/:id/deactivate',
      'POST /api/v1/platform/staff/invitations',
    ]);
  });

  it('lists every @Idempotent() route', () => {
    expect(idempotency.filter((r) => r.idempotent).map((r) => r.route)).toEqual([
      'DELETE /api/v1/catalog/price-rules/:id',
      'DELETE /api/v1/invitations/:id',
      'DELETE /api/v1/label-overrides/:locale/:key',
      'DELETE /api/v1/locations/:id',
      'DELETE /api/v1/members/:id',
      'DELETE /api/v1/pos/areas/:id',
      'DELETE /api/v1/reservations/settings/:key',
      'DELETE /api/v1/roles/:id',
      'DELETE /api/v1/settings/:key',
      'PATCH /api/v1/catalog/categories/:id',
      'PATCH /api/v1/catalog/price-rules/:id',
      'PATCH /api/v1/catalog/products/:id',
      'PATCH /api/v1/inventory/items/:id',
      'PATCH /api/v1/inventory/warehouses/:id',
      'PATCH /api/v1/locations/:id',
      'PATCH /api/v1/members/:id',
      'PATCH /api/v1/number-series/:key',
      'PATCH /api/v1/organization',
      'PATCH /api/v1/pos/areas/:id',
      'PATCH /api/v1/pos/orders/:id',
      'PATCH /api/v1/pos/printers/:id',
      'PATCH /api/v1/pos/tables/:id',
      'PATCH /api/v1/reservations/:id',
      'PATCH /api/v1/reservations/combinations/:id',
      'PATCH /api/v1/roles/:id',
      'PATCH /api/v1/staff/:id',
      'POST /api/v1/catalog/categories',
      'POST /api/v1/catalog/categories/bulk',
      'POST /api/v1/catalog/price-rules',
      'POST /api/v1/catalog/products',
      'POST /api/v1/catalog/products/bulk',
      'POST /api/v1/catalog/products/import',
      'POST /api/v1/catalog/products/number',
      'POST /api/v1/inventory/adjustments',
      'POST /api/v1/inventory/items',
      'POST /api/v1/inventory/receipts',
      'POST /api/v1/inventory/transfers',
      'POST /api/v1/inventory/warehouses',
      'POST /api/v1/invitations',
      'POST /api/v1/locations',
      'POST /api/v1/pos/areas',
      'POST /api/v1/pos/orders/:id/close',
      'POST /api/v1/pos/orders/:id/voids',
      'POST /api/v1/pos/orders/:orderId/tickets/:id/served',
      'POST /api/v1/pos/print-jobs/:id/reprint',
      'POST /api/v1/pos/print-jobs/:id/result',
      'POST /api/v1/pos/print-jobs/bill',
      'POST /api/v1/pos/print-jobs/claim',
      'POST /api/v1/pos/printer-commands',
      'POST /api/v1/pos/printer-commands/:id/result',
      'POST /api/v1/pos/printer-commands/claim',
      'POST /api/v1/pos/printers',
      'POST /api/v1/pos/printers/:id/archive',
      'POST /api/v1/pos/stations/bar/tickets/:id/status',
      'POST /api/v1/pos/stations/kitchen/tickets/:id/status',
      'POST /api/v1/pos/tables',
      'POST /api/v1/pos/tables/:id/menu-token',
      'POST /api/v1/pos/tables/:tableId/tickets',
      'POST /api/v1/reservations',
      'POST /api/v1/reservations/:id/arrive',
      'POST /api/v1/reservations/:id/cancel',
      'POST /api/v1/reservations/:id/finish',
      'POST /api/v1/reservations/:id/no-show',
      'POST /api/v1/reservations/:id/seat',
      'POST /api/v1/reservations/:id/undo',
      'POST /api/v1/reservations/combinations',
      'POST /api/v1/reservations/guests/:id/anonymise',
      'POST /api/v1/reservations/walk-ins',
      'POST /api/v1/roles',
      'POST /api/v1/staff',
      'POST /api/v1/staff/:id/deactivate',
      'POST /api/v1/staff/:id/reactivate',
      'PUT /api/v1/inventory/recipes/:productId',
      'PUT /api/v1/label-overrides/:locale/:key',
      'PUT /api/v1/number-series/:key/counter',
      'PUT /api/v1/reservations/settings/:key',
      'PUT /api/v1/reservations/tables/:tableId/rule',
      'PUT /api/v1/settings/:key',
    ]);
  });

  it('refuses to boot the api when a write route has no idempotency marker', async () => {
    @Controller('unmarked')
    class UnmarkedController {
      @RequirePermission('platform.settings.manage')
      @Post()
      create(): void {}
    }
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [UnmarkedController],
    }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    await expect(app.init()).rejects.toThrow(
      'POST /api/v1/unmarked: no @Idempotent() or @IdempotencyExempt(reason)',
    );
    await app.close();
  });
});
