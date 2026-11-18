import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Migrations are SQL: a Prisma enum mapped to another database name (`enum StockUnit { … @@map("stock_unit") }`) must
 * be written by its database name. "StockUnit" in a migration failed a production deploy (vendor invoices, ADR 0054);
 * this check needs no database, so it runs with the unit tests.
 */
const PRISMA = join(__dirname, '../../../prisma');

function mappedEnums(): Map<string, string> {
  const schema = readFileSync(join(PRISMA, 'schema.prisma'), 'utf8');
  const enums = new Map<string, string>();
  for (const match of schema.matchAll(/enum\s+(\w+)\s*\{([^}]*)\}/g)) {
    const mapped = /@@map\("([^"]+)"\)/.exec(match[2]!);
    if (mapped && mapped[1] !== match[1]) enums.set(match[1]!, mapped[1]!);
  }
  return enums;
}

/** The SQL without comments, so explaining a past mistake in one stays allowed. */
const code = (sql: string) =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

describe('migrations use database type names', () => {
  it('never names a mapped enum by its Prisma name', () => {
    const enums = mappedEnums();
    expect(enums.size).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const dir of readdirSync(join(PRISMA, 'migrations'), { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const sql = code(readFileSync(join(PRISMA, 'migrations', dir.name, 'migration.sql'), 'utf8'));
      for (const [prismaName, dbName] of enums) {
        if (sql.includes(`"${prismaName}"`))
          offenders.push(`${dir.name}: "${prismaName}" → "${dbName}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
