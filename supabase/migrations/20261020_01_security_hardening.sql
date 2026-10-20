-- Security Hardening Migration: Session Registry and RLS
-- This migration implements the admin session registry and hardens RLS policies.

-- 1. Session Registry Table
CREATE TABLE IF NOT EXISTS admin_sessions (
    sid VARCHAR PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('shop_admin', 'super_admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revocation_status BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_status ON admin_sessions(revocation_status);

ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;

-- 2. RLS Hardening
-- We want to ensure that 'anon' and 'authenticated' roles cannot access admin-sensitive tables.
-- By default, enabling RLS denies all. We just need to ensure any overly broad policies are gone.

-- users table
DROP POLICY IF EXISTS "deny_anon_users" ON users;
CREATE POLICY "deny_all_browser_access_users" ON users FOR ALL USING (false);

-- shops table
DROP POLICY IF EXISTS "deny_anon_shops" ON shops;
CREATE POLICY "deny_all_browser_access_shops" ON shops FOR ALL USING (false);

-- orders table
DROP POLICY IF EXISTS "deny_anon_orders" ON orders;
CREATE POLICY "deny_all_browser_access_orders" ON orders FOR ALL USING (false);

-- order_files table
DROP POLICY IF EXISTS "deny_anon_order_files" ON order_files;
CREATE POLICY "deny_all_browser_access_order_files" ON order_files FOR ALL USING (false);

-- payments table
DROP POLICY IF EXISTS "deny_anon_payments" ON payments;
CREATE POLICY "deny_all_browser_access_payments" ON payments FOR ALL USING (false);

-- session table
-- session table is already RLS enabled and has no policies, which is secure.
-- We just ensure it remains that way.
DROP POLICY IF EXISTS "deny_all_browser_access_session" ON "session";
CREATE POLICY "deny_all_browser_access_session" ON "session" FOR ALL USING (false);

-- admin_sessions table
DROP POLICY IF EXISTS "deny_all_browser_access_admin_sessions" ON admin_sessions;
CREATE POLICY "deny_all_browser_access_admin_sessions" ON admin_sessions FOR ALL USING (false);
