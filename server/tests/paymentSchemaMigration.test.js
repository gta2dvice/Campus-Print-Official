const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const root = path.join(__dirname, '..', '..');
const migration = fs.readFileSync(
    path.join(root, 'supabase', 'migrations', '20261009_01_payment_order_schema.sql'),
    'utf8'
);
const schema = fs.readFileSync(path.join(root, 'supabase', 'schema.sql'), 'utf8');

describe('payment order database migration', () => {
    it('uses the application payment status type, default, and allowed values', () => {
        assert.match(migration, /ADD COLUMN IF NOT EXISTS payment_status VARCHAR\(20\)/i);
        assert.match(migration, /ALTER COLUMN payment_status SET DEFAULT 'PAID'/i);
        assert.match(migration, /ALTER COLUMN payment_status SET NOT NULL/i);
        assert.match(
            migration,
            /CHECK \(payment_status IN \('PAYMENT_PENDING', 'PAID', 'PAYMENT_FAILED'\)\)/i
        );
    });

    it('does not promote unknown unpaid orders during backfill', () => {
        assert.match(migration, /p\.method = 'cashfree' AND p\.status = 'pending' THEN 'PAYMENT_PENDING'/i);
        assert.match(migration, /p\.method = 'cashfree' AND p\.status IN \('failed', 'refunded'\) THEN 'PAYMENT_FAILED'/i);
        assert.match(migration, /ELSE 'PAYMENT_PENDING'/i);
        assert.match(migration, /ELSE 'PAYMENT_PENDING'\s*END\s*WHERE o\.payment_status IS NULL/i);
    });

    it('repairs guest, per-file print, gateway, and ticket-idempotency schema', () => {
        for (const column of [
            'student_id', 'collection_date', 'ticket_access_token_hash',
            'guest_full_name', 'guest_phone', 'guest_classroom'
        ]) {
            assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, 'i'));
        }
        for (const column of ['printing_side', 'copies', 'color_mode']) {
            assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`, 'i'));
        }
        assert.match(migration, /ADD COLUMN IF NOT EXISTS gateway_order_id VARCHAR\(100\)/i);
        assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_gateway_order_id/i);
        assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_ticket_number/i);
        assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_ticket_access_token_hash/i);
        assert.match(schema, /status\s+VARCHAR\(20\)\s+NOT NULL DEFAULT 'pending'/i);
    });
});
