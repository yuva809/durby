-- ADR 0062: box, bucket, bag and packet, for goods a distributor buys and counts that way. Expand only: values are
-- only added (a release before this one never meets them on items it knows).
ALTER TYPE "stock_unit" ADD VALUE IF NOT EXISTS 'box';
ALTER TYPE "stock_unit" ADD VALUE IF NOT EXISTS 'bucket';
ALTER TYPE "stock_unit" ADD VALUE IF NOT EXISTS 'bag';
ALTER TYPE "stock_unit" ADD VALUE IF NOT EXISTS 'packet';
