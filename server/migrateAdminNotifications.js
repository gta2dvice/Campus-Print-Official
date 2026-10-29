/**
 * Database migration to track admin payment-success notifications.
 * Ensures only one admin email is sent per order regardless of how many times
 * the payment is verified or ticket is recovered.
 */
async function migrateAdminNotifications() {
    const pool = require('./db');
    console.log('[MIGRATION] Ensuring admin_payment_notifications table exists...');
    try {
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS admin_payment_notifications (
                order_id INT PRIMARY KEY,
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                status VARCHAR(20) DEFAULT 'SENT',
                provider_message_id VARCHAR(255),
                last_error TEXT,
                CONSTRAINT fk_admin_notif_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
            )
        `);
        console.log('[MIGRATION] admin_payment_notifications table verified.');
    } catch (err) {
        console.error('[MIGRATION_FAILED]', err.message);
        process.exit(1);
    }
}

// Execute migration if run directly
if (require.main === module) {
    migrateAdminNotifications().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { migrateAdminNotifications };
