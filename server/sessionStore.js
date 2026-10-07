const PgSessionStore = require('connect-pg-simple');
const db = require('./db');

const TABLE = 'session';

/**
 * Sessions live in Postgres so logins survive server restarts, Render spin-downs and
 * multiple instances (the default MemoryStore loses them all).
 */
function createSessionStore(session) {
    const Store = PgSessionStore(session);
    return new Store({
        pool: db.pool,
        tableName: TABLE,
        // ensureSessionTable() creates it (with RLS on) before the server starts listening.
        createTableIfMissing: false,
        pruneSessionInterval: 60 * 15 // seconds — clears expired rows
    });
}

/**
 * Creates the session table if needed and keeps row-level security on, so Supabase's
 * public REST API (anon key) can't read or forge sessions. The server connects as the
 * table owner, which RLS doesn't restrict. Mirrors supabase/schema.sql.
 */
async function ensureSessionTable() {
    await db.pool.query(`
        CREATE TABLE IF NOT EXISTS "${TABLE}" (
            "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
            "sess" json NOT NULL,
            "expire" timestamp(6) NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "${TABLE}" ("expire");
        ALTER TABLE "${TABLE}" ENABLE ROW LEVEL SECURITY;
    `);
}

module.exports = { createSessionStore, ensureSessionTable };
