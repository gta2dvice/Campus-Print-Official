// Focused, idempotent migration for the shared payment finalizer + ticket states.
// Additive only — no data loss. Safe to re-run. Run with:
//   node server/migrate_payment_finalization.js
// server/initDb.js also applies these statements.
require('./loadEnv');

const PAYMENT_FINALIZATION_STATEMENTS = [
    // Ticket lifecycle on the order: PENDING_PAYMENT → GENERATION_PENDING → READY.
    // GENERATION_PENDING is the recoverable "paid, ticket not issued yet" state.
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS ticket_status VARCHAR(30) NOT NULL DEFAULT 'PENDING_PAYMENT'`,
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`,
    // Canonical method on the order (payments.method keeps its legacy lowercase values).
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20)`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'INR'`,
    `ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ`,

    // Backfill existing rows (only rows still holding the defaults).
    `UPDATE orders
        SET ticket_status = CASE WHEN ticket_number IS NOT NULL THEN 'READY' ELSE 'GENERATION_PENDING' END
      WHERE payment_status = 'PAID' AND ticket_status = 'PENDING_PAYMENT'`,
    `UPDATE orders o
        SET payment_method = CASE lp.method
                WHEN 'cashfree' THEN 'CASHFREE'
                WHEN 'upi_qr' THEN 'LEGACY_UPI_QR'
                WHEN 'whatsapp' THEN 'WHATSAPP'
                WHEN 'none' THEN 'PAY_AT_SHOP'
                WHEN 'simulated' THEN 'SIMULATED'
            END
       FROM (SELECT DISTINCT ON (order_id) order_id, method FROM payments ORDER BY order_id, id DESC) lp
      WHERE lp.order_id = o.id AND o.payment_method IS NULL`,
    `UPDATE payments SET paid_at = updated_at WHERE status = 'success' AND paid_at IS NULL`,
    `UPDATE orders o
        SET paid_at = p.paid_at
       FROM payments p
      WHERE p.order_id = o.id AND p.status = 'success' AND o.payment_status = 'PAID' AND o.paid_at IS NULL`,

    `ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_ticket_status_check`,
    `ALTER TABLE orders ADD CONSTRAINT orders_ticket_status_check
        CHECK (ticket_status IN ('PENDING_PAYMENT', 'GENERATION_PENDING', 'READY'))`,
    `ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check`,
    `ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check
        CHECK (payment_method IS NULL OR payment_method IN ('CASHFREE', 'UPI_QR', 'WHATSAPP', 'PAY_AT_SHOP', 'SIMULATED'))`,

    // An order may have many payment attempts (failed → failed → success) but at
    // most ONE successful one. Replaces the old one-Cashfree-attempt-per-order index,
    // which blocked retrying a failed Cashfree payment on the same order.
    `DROP INDEX IF EXISTS idx_payments_gateway_order_internal_order`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_success_per_order
        ON payments (order_id) WHERE status = 'success'`,
    // A gateway/UPI transaction can settle only one payment.
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_success_transaction_ref
        ON payments (method, transaction_ref) WHERE status = 'success' AND transaction_ref IS NOT NULL`,
    // Recovery sweep for paid orders whose ticket wasn't issued yet.
    `CREATE INDEX IF NOT EXISTS idx_orders_ticket_generation_pending
        ON orders (id) WHERE ticket_status = 'GENERATION_PENDING'`
];

async function migrate() {
    const pool = require('./db');
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required (set it in server/.env).');
    }
    try {
        for (const sql of PAYMENT_FINALIZATION_STATEMENTS) {
            await pool.query(sql);
            console.log('✓', sql.replace(/\s+/g, ' ').slice(0, 80));
        }
        console.log('\n✅ Payment finalization migration applied.');
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

module.exports = { PAYMENT_FINALIZATION_STATEMENTS };
