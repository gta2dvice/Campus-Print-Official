-- Additive, idempotent schema for phone-verified order recovery.
-- Run against the production Supabase database before deploying the recovery API.
CREATE INDEX IF NOT EXISTS idx_orders_guest_phone ON orders (guest_phone);

CREATE TABLE IF NOT EXISTS order_recovery_otps (
    id          SERIAL PRIMARY KEY,
    phone       VARCHAR(20) NOT NULL,
    otp_hash    VARCHAR(64) NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_order_recovery_otps_phone ON order_recovery_otps (phone);
CREATE INDEX IF NOT EXISTS idx_order_recovery_otps_expires_at ON order_recovery_otps (expires_at);
ALTER TABLE order_recovery_otps ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS rate_limits (
    bucket       VARCHAR(255) PRIMARY KEY,
    count        INTEGER NOT NULL DEFAULT 0,
    window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
