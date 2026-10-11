require('./loadEnv');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');

function splitSql(sql) {
    return sql
        .replace(/--.*$/gm, '')
        .split(';')
        .map(s => s.trim())
        .filter(s => s.length > 0);
}

async function initDb() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required. Set it in server/.env (Supabase Dashboard → Database → URI).');
    }

    const schemaPath = path.join(__dirname, '../supabase/schema.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf8');
    const statements = splitSql(schemaSql);

    for (const statement of statements) {
        await pool.query(statement);
    }
    console.log('✅ Supabase Postgres schema applied');

    await pool.query(`ALTER TABLE order_files ADD COLUMN IF NOT EXISTS printing_side VARCHAR(10) NOT NULL DEFAULT 'single'`);
    await pool.query(`ALTER TABLE order_files ADD COLUMN IF NOT EXISTS copies INTEGER NOT NULL DEFAULT 1`);
    await pool.query(`ALTER TABLE order_files ADD COLUMN IF NOT EXISTS color_mode VARCHAR(10) NOT NULL DEFAULT 'bw'`);
    await pool.query(`ALTER TABLE order_files ADD COLUMN IF NOT EXISTS file_type VARCHAR(10) NULL`);
    await pool.query(`ALTER TABLE order_files ADD COLUMN IF NOT EXISTS page_count INTEGER NULL`);
    await pool.query(`ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_upi VARCHAR(100)`);
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_reference VARCHAR(40)`);
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS qr_expires_at TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_payment_reference ON payments (payment_reference)`);
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_order_id VARCHAR(100)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_gateway_order_id ON payments (gateway_order_id)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_gateway_order_internal_order ON payments (order_id) WHERE gateway_order_id IS NOT NULL`);
    await pool.query(`ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) NOT NULL DEFAULT 'PAID'`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS ticket_access_token_hash CHAR(64)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_full_name VARCHAR(255)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(30)`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_classroom VARCHAR(100)`);
    await pool.query(`ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL`);
    await pool.query(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_user_id_fkey`);
    await pool.query(
        `ALTER TABLE orders ADD CONSTRAINT orders_user_id_fkey
         FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL`
    );
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_ticket_number ON orders (ticket_number) WHERE ticket_number IS NOT NULL`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_ticket_access_token_hash ON orders (ticket_access_token_hash) WHERE ticket_access_token_hash IS NOT NULL`);
    try {
        await pool.query(
            `ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
             CHECK (payment_status IN ('PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED'))`
        );
    } catch (error) {
        if (error.code !== '42710') throw error;
    }

    // ── Guest orders & phone-based order recovery (idempotent) ──────────────
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_full_name VARCHAR(255) NULL`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_phone VARCHAR(20) NULL`);
    await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS guest_classroom VARCHAR(100) NULL`);
    await pool.query(`ALTER TABLE orders ALTER COLUMN user_id DROP NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_orders_guest_phone ON orders (guest_phone)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS order_recovery_otps (
        id          SERIAL PRIMARY KEY,
        phone       VARCHAR(20)  NOT NULL,
        otp_hash    VARCHAR(255) NOT NULL,
        attempts    INTEGER      NOT NULL DEFAULT 0,
        expires_at  TIMESTAMPTZ  NOT NULL,
        consumed_at TIMESTAMPTZ  NULL,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_recovery_otps_phone ON order_recovery_otps (phone)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_recovery_otps_expires_at ON order_recovery_otps (expires_at)`);
    await pool.query(`CREATE TABLE IF NOT EXISTS rate_limits (
        bucket       VARCHAR(255) PRIMARY KEY,
        count        INTEGER      NOT NULL DEFAULT 0,
        window_start TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`ALTER TABLE order_recovery_otps ENABLE ROW LEVEL SECURITY`);
    await pool.query(`ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY`);

    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    if (adminEmail && adminPassword) {
        const hashed = await bcrypt.hash(adminPassword, 10);
        await pool.query(
            `INSERT INTO users (email, password, is_admin, role, shop_id)
             VALUES (?, ?, 1, 'shop_admin', 1)
             ON CONFLICT (email) DO UPDATE SET is_admin = 1, role = 'shop_admin', shop_id = COALESCE(users.shop_id, 1), password = EXCLUDED.password`,
            [adminEmail.toLowerCase().trim(), hashed]
        );
        await pool.query(
            `UPDATE shops SET owner_user_id = (SELECT id FROM users WHERE email = ?) WHERE id = 1 AND owner_user_id IS NULL`,
            [adminEmail.toLowerCase().trim()]
        );
        console.log(`✅ Shop admin account ready (${adminEmail})`);
    } else {
        console.log('ℹ️  ADMIN_EMAIL/ADMIN_PASSWORD not set — skipping shop admin seed');
    }

    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL;
    const superAdminPassword = process.env.SUPER_ADMIN_PASSWORD;
    if (superAdminEmail && superAdminPassword) {
        const hashed = await bcrypt.hash(superAdminPassword, 10);
        await pool.query(
            `INSERT INTO users (email, password, is_admin, role)
             VALUES (?, ?, 1, 'super_admin')
             ON CONFLICT (email) DO UPDATE SET is_admin = 1, role = 'super_admin', password = EXCLUDED.password`,
            [superAdminEmail.toLowerCase().trim(), hashed]
        );
        console.log(`✅ Super admin account ready (${superAdminEmail})`);
    } else {
        console.log('ℹ️  SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD not set — skipping super admin seed');
    }

    await pool.end();
    console.log('\n🎉 Database initialised successfully!');
}

initDb().catch(err => {
    console.error('❌ Database init failed:', err.message);
    process.exit(1);
});
