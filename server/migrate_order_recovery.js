// Focused, idempotent migration for guest order recovery + multi-format uploads.
// Additive only (CREATE / ADD COLUMN ... IF NOT EXISTS) — no data loss, no
// admin re-seed. Run with: node server/migrate_order_recovery.js
require('./loadEnv');
const pool = require('./db');

async function migrate() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required (set it in server/.env).');
    }

    const statements = [
        // Guest-order columns + phone lookup index (orders.id stays the PK).
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_full_name VARCHAR(255) NULL`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(20) NULL`,
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_classroom VARCHAR(100) NULL`,
        `ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_orders_guest_phone ON orders (guest_phone)`,

        // OTP store for recovery (hashed OTPs, disposable).
        `CREATE TABLE IF NOT EXISTS order_recovery_otps (
            id          SERIAL PRIMARY KEY,
            phone       VARCHAR(20)  NOT NULL,
            otp_hash    VARCHAR(255) NOT NULL,
            attempts    INTEGER      NOT NULL DEFAULT 0,
            expires_at  TIMESTAMPTZ  NOT NULL,
            consumed_at TIMESTAMPTZ  NULL,
            created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )`,
        `CREATE INDEX IF NOT EXISTS idx_order_recovery_otps_phone ON order_recovery_otps (phone)`,
        `CREATE INDEX IF NOT EXISTS idx_order_recovery_otps_expires_at ON order_recovery_otps (expires_at)`,

        // Fixed-window rate-limit counters.
        `CREATE TABLE IF NOT EXISTS rate_limits (
            bucket       VARCHAR(255) PRIMARY KEY,
            count        INTEGER      NOT NULL DEFAULT 0,
            window_start TIMESTAMPTZ  NOT NULL DEFAULT NOW()
        )`,

        // Multi-format uploads: store resolved type + page count per file.
        `ALTER TABLE order_files ADD COLUMN IF NOT EXISTS file_type VARCHAR(10) NULL`,
        `ALTER TABLE order_files ADD COLUMN IF NOT EXISTS page_count INTEGER NULL`,

        // Personal WhatsApp flow: admin-configurable UPI / payment number.
        `ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_upi VARCHAR(100)`,

        // Pay via UPI QR: secure per-attempt reference, QR expiry, paid timestamp.
        `ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(40)`,
        `ALTER TABLE payments ADD COLUMN IF NOT EXISTS qr_expires_at TIMESTAMPTZ`,
        `ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payment_reference ON payments (payment_reference)`,

        // Keep RLS consistent with the other app tables (service role bypasses it).
        `ALTER TABLE order_recovery_otps ENABLE ROW LEVEL SECURITY`,
        `ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY`,
    ];

    for (const sql of statements) {
        await pool.query(sql);
        console.log('✓', sql.replace(/\s+/g, ' ').slice(0, 70));
    }

    await pool.end();
    console.log('\n✅ Order-recovery migration applied.');
}

migrate().catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
});
