-- Repair the order/payment columns used by the Cashfree and guest-order flows.
-- Safe to re-run. Existing rows are retained; unknown legacy payment state is
-- conservatively left unpaid instead of being promoted to PAID.
BEGIN;

ALTER TABLE public.orders
    ADD COLUMN IF NOT EXISTS student_id INTEGER REFERENCES public.student_profiles(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS collection_date DATE,
    ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20),
    ADD COLUMN IF NOT EXISTS ticket_access_token_hash CHAR(64),
    ADD COLUMN IF NOT EXISTS guest_full_name VARCHAR(255),
    ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(30),
    ADD COLUMN IF NOT EXISTS guest_classroom VARCHAR(100);

ALTER TABLE public.orders ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.payments ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.order_files
    ADD COLUMN IF NOT EXISTS printing_side VARCHAR(10) NOT NULL DEFAULT 'single',
    ADD COLUMN IF NOT EXISTS copies INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS color_mode VARCHAR(10) NOT NULL DEFAULT 'bw';

ALTER TABLE public.payments
    ADD COLUMN IF NOT EXISTS gateway_order_id VARCHAR(100);

WITH latest_payment AS (
    SELECT DISTINCT ON (order_id) order_id, method, status
    FROM public.payments
    ORDER BY order_id, updated_at DESC, id DESC
)
UPDATE public.orders AS o
SET payment_status = CASE
    WHEN p.method = 'cashfree' AND p.status = 'success' THEN 'PAID'
    WHEN p.method = 'cashfree' AND p.status = 'pending' THEN 'PAYMENT_PENDING'
    WHEN p.method = 'cashfree' AND p.status IN ('failed', 'refunded') THEN 'PAYMENT_FAILED'
    WHEN p.status = 'success' OR o.ticket_number IS NOT NULL THEN 'PAID'
    WHEN p.status IN ('failed', 'refunded') THEN 'PAYMENT_FAILED'
    ELSE 'PAYMENT_PENDING'
END
FROM latest_payment AS p
WHERE p.order_id = o.id
  AND (o.payment_status IS NULL OR o.payment_status NOT IN ('PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED'));

UPDATE public.orders AS o
SET payment_status = CASE
    WHEN o.ticket_number IS NOT NULL THEN 'PAID'
    ELSE 'PAYMENT_PENDING'
END
WHERE o.payment_status IS NULL
   OR o.payment_status NOT IN ('PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED');

ALTER TABLE public.orders
    ALTER COLUMN payment_status SET DEFAULT 'PAID',
    ALTER COLUMN payment_status SET NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.orders'::regclass
          AND conname = 'orders_payment_status_check'
    ) THEN
        ALTER TABLE public.orders
            ADD CONSTRAINT orders_payment_status_check
            CHECK (payment_status IN ('PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED')) NOT VALID;
    END IF;
END;
$$;

ALTER TABLE public.orders VALIDATE CONSTRAINT orders_payment_status_check;

CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_ticket_number
    ON public.orders (ticket_number) WHERE ticket_number IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_ticket_access_token_hash
    ON public.orders (ticket_access_token_hash) WHERE ticket_access_token_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_gateway_order_id
    ON public.payments (gateway_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_gateway_order_internal_order
    ON public.payments (order_id) WHERE gateway_order_id IS NOT NULL;

COMMIT;
