-- Migration: Email OTP-based Order Recovery
-- Adds guest_email to orders and email to order_recovery_otps.
-- Safe to re-run (idempotent). Does not modify or overwrite historical records.
BEGIN;

-- 1. Orders: guest_email column and lower-case index for email-based lookup
ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS guest_email VARCHAR(255) NULL;

CREATE INDEX IF NOT EXISTS idx_orders_guest_email
    ON public.orders (LOWER(guest_email))
    WHERE guest_email IS NOT NULL;

-- 2. Order recovery OTPs: support email, make phone nullable, and add indexes
ALTER TABLE public.order_recovery_otps
    ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL;

ALTER TABLE public.order_recovery_otps
    ALTER COLUMN phone DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_recovery_otps_email
    ON public.order_recovery_otps (LOWER(email))
    WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_order_recovery_otps_created_at
    ON public.order_recovery_otps (created_at);

COMMIT;
