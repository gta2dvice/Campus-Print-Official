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
    await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_order_id VARCHAR(100)`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_gateway_order_id ON payments (gateway_order_id)`);
    await pool.query(`ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL`);

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
