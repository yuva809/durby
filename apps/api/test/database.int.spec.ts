import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { ConfigModule } from '../src/platform/config';
import { DatabaseModule, PrismaService } from '../src/platform/database';

describe('database connection', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule],
    }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('runs a query through PrismaService', async () => {
    const rows = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
    expect(rows).toEqual([{ ok: 1 }]);
  });

  it('connects as durby_app, which cannot bypass RLS or create objects', async () => {
    const [role] = await prisma.$queryRaw<
      { name: string; super: boolean; bypassrls: boolean; can_create: boolean }[]
    >`
      SELECT current_user AS name, rolsuper AS super, rolbypassrls AS bypassrls,
             has_schema_privilege('durby_app', 'public', 'CREATE') AS can_create
      FROM pg_roles WHERE rolname = current_user`;
    expect(role).toEqual({ name: 'durby_app', super: false, bypassrls: false, can_create: false });
  });

  it('has the migrations applied by durby_migrator', async () => {
    const migrator = new Client({ connectionString: inject('migrationDatabaseUrl') });
    await migrator.connect();
    try {
      const { rows } = await migrator.query<{ migration_name: string }>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      );
      expect(rows.map((r) => r.migration_name)).toContain('20261021000000_init');
    } finally {
      await migrator.end();
    }
  });
});
