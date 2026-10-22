-- Migration: Ensure binding columns exist for per-document tracking.
-- 1. orders.spiral_binding: canonical order-level flag.
-- 2. order_files.spiral_binding: canonical per-document flag.
-- 3. orders.binding_charge: record total binding cost.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS spiral_binding SMALLINT DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS binding_charge NUMERIC(10,2) DEFAULT 0.00;
ALTER TABLE order_files ADD COLUMN IF NOT EXISTS spiral_binding SMALLINT NOT NULL DEFAULT 0