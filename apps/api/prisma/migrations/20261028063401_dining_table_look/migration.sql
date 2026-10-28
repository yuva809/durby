-- How a table is drawn on the floor and tables pages (docs/modules/pos.md). Expand-only, with defaults.
-- Note: `prisma migrate dev` also proposes dropping the hand-written consistency FKs and indexes of pos_orders
-- (they are not expressible in schema.prisma); those statements were removed and must be removed again in later
-- generated migrations.
CREATE TYPE "dining_table_shape" AS ENUM ('square', 'round', 'long');
CREATE TYPE "dining_table_color" AS ENUM ('neutral', 'sand', 'sage', 'blue', 'rose', 'violet', 'amber', 'slate', 'teal');

ALTER TABLE "dining_tables" ADD COLUMN "color" "dining_table_color" NOT NULL DEFAULT 'neutral',
ADD COLUMN "shape" "dining_table_shape" NOT NULL DEFAULT 'square';
