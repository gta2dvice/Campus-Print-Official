const pool = require('./db');
async function migrate() {
    try {
        console.log('Migrating orders table...');
        await pool.execute('ALTER TABLE orders ADD COLUMN IF NOT EXISTS collection_date DATE');
        console.log('Migration successful!');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await pool.end();
    }
}
migrate();
