// Itemised order charges: the printer's printing amount vs Campus Print's extra
// charges, saved per order at creation (server/pricing.js). Additive only, safe to
// re-run. Existing orders keep NULLs: they were saved before itemising and are shown
// as "not itemised" / an estimate — their stored totals are never recalculated.
//   node server/migrate_order_charges.js
// server/initDb.js also applies these statements.
require('./loadEnv');

const ORDER_CHARGES_STATEMENTS = [
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS printing_amount NUMERIC(10,2)`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_charge NUMERIC(10,2)`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_charge NUMERIC(10,2)`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS classroom_charge NUMERIC(10,2)`,
    `ALTER TABLE order_files ADD COLUMN IF NOT EXISTS printing_charge NUMERIC(10,2)`
];

async function migrate() {
    const pool = require('./db');
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required (set it in server/.env).');
    }
    try {
        for (const sql of ORDER_CHARGES_STATEMENTS) {
            await pool.query(sql);
            console.log('✓', sql);
        }
        console.log('\n✅ Order charges migration applied.');
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    migrate().catch(err => {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    });
}

module.exports = { ORDER_CHARGES_STATEMENTS };
