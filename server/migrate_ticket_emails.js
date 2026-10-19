// Focused, idempotent migration for automatic ticket email delivery (outbox).
// Additive only — no data loss. Safe to re-run. Run with:
//   node server/migrate_ticket_emails.js
// server/initDb.js also applies these statements.
require('./loadEnv');

const TICKET_EMAIL_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS order_ticket_emails (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        recipient_email VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
            CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
        attempts INTEGER NOT NULL DEFAULT 0,
        provider VARCHAR(50) NULL,
        provider_message_id VARCHAR(100) NULL,
        last_error TEXT NULL,
        sent_at TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_order_ticket_emails_order_id ON order_ticket_emails (order_id)`,
    `CREATE INDEX IF NOT EXISTS idx_order_ticket_emails_status ON order_ticket_emails (status)`,
    `CREATE INDEX IF NOT EXISTS idx_order_ticket_emails_recipient_email ON order_ticket_emails (LOWER(recipient_email))`
];

async function migrate() {
    const pool = require('./db');
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required (set it in server/.env).');
    }
    try {
        for (const sql of TICKET_EMAIL_STATEMENTS) {
            await pool.query(sql);
            console.log('✓', sql.replace(/\s+/g, ' ').slice(0, 80));
        }
        console.log('\n✅ Ticket email delivery migration applied.');
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

module.exports = { TICKET_EMAIL_STATEMENTS };
