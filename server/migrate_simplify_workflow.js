// Simplified admin workflow (Pending → Accept → Completed / Ready for Pickup):
// moves PAID orders left in a removed intermediate state (accepted / printing /
// ready) to 'completed' so they appear in Completed Orders. Data only; no schema
// change; payment, ticket and file data are untouched. Safe to re-run.
//   node server/migrate_simplify_workflow.js
require('./loadEnv');
const pool = require('./db');

async function migrate() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required (set it in server/.env).');
    }
    try {
        const [rows] = await pool.query(
            `UPDATE orders SET status = 'completed'
             WHERE status IN ('accepted', 'printing', 'ready') AND payment_status = 'PAID'
             RETURNING id`
        );
        console.log(`✓ Moved ${rows.length} order(s) to completed${rows.length ? `: ${rows.map(r => r.id).join(', ')}` : ''}`);
        const [[left]] = await pool.query(
            `SELECT COUNT(*) AS n FROM orders WHERE status IN ('accepted', 'printing', 'ready')`
        );
        if (Number(left.n) > 0) {
            console.log(`ℹ️  ${left.n} unpaid order(s) are still in an intermediate state; they need payment confirmation first.`);
        }
    } finally {
        await pool.end();
    }
}

migrate().catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
});
