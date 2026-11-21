-- The reason of a correction to an approved vendor invoice line (ADR 0078). Expand only: older releases ignore it.

ALTER TYPE "stock_adjustment_reason" ADD VALUE 'correction';
