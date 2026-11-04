-- Stations (ADR 0025): a category's items print on its station's ticket; a ticket keeps the station it was sent to.
-- Expand only: older releases ignore both columns and keep writing kitchen tickets. ADD COLUMN with a default
-- fires no row triggers, so the append-only triggers on pos_kitchen_tickets are untouched.
CREATE TYPE "prep_station" AS ENUM ('kitchen', 'bar');

ALTER TABLE "product_categories" ADD COLUMN "station" "prep_station" NOT NULL DEFAULT 'kitchen';

ALTER TABLE "pos_kitchen_tickets" ADD COLUMN "station" "prep_station" NOT NULL DEFAULT 'kitchen';
