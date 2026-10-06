const pool = require('./db');
async function migrate() {
    try {
        console.log('Migrating order_files table...');
        await pool.execute('ALTER TABLE order_files ADD COLUMN IF NOT EXISTS copies INT DEFAULT 1');
        console.log('Migration successful!');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await pool.end();
    }
}
migrate();
