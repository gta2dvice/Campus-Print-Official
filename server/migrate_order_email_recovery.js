// Focused, idempotent migration for email OTP guest order recovery.
// Additive only (ALTER TABLE / ADD COLUMN / CREATE INDEX ... IF NOT EXISTS).
// Safe to run against production database without downtime or data loss.
// Run with: node server/migrate_order_email_recovery.js
require('./loadEnv');
const pool = require('./db');

async function migrate() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required (set it in server/.env).');
    }

    const statements = [
        // 1. Add guest_email to orders
        `ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_email VARCHAR(255) NULL`,
        `CREATE INDEX IF NOT EXISTS idx_orders_guest_email ON orders (LOWER(guest_email)) WHERE guest_email IS NOT NULL`,

        // 2. Update order_recovery_otps to support email
        `ALTER TABLE order_recovery_otps ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL`,
        `ALTER TABLE order_recovery_otps ALTER COLUMN phone DROP NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_order_recovery_otps_email ON order_recovery_otps (LOWER(email)) WHERE email IS NOT NULL`,
        `CREATE INDEX IF NOT EXISTS idx_order_recovery_otps_created_at ON order_recovery_otps (created_at)`
    ];

    for (const sql of statements) {
        await pool.query(sql);
        console.log('✓', sql.replace(/\s+/g, ' ').slice(0, 70));
    }

    await pool.end();
    console.log('\n✅ Email order recovery migration applied.');
}

migrate().catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
});
