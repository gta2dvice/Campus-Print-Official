const pool = require('./db');
async function migrate() {
    try {
        console.log('Migrating shops table (payment QR)...');
        await pool.execute('ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_qr_path VARCHAR(500)');
        await pool.execute('ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_qr_mime VARCHAR(100)');
        console.log('Migrating payments table (guest payments)...');
        // Guest orders have no user account, so their payment rows have no user_id.
        await pool.execute('ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL');
        console.log('Migration successful!');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await pool.end();
    }
}
migrate();
