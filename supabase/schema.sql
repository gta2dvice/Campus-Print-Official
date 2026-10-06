-- Campus Print — Supabase PostgreSQL schema
-- Run this in the Supabase SQL Editor (once per project).
-- Does not delete existing application data.

CREATE TABLE IF NOT EXISTS users (
    id         SERIAL PRIMARY KEY,
    email      VARCHAR(255) UNIQUE NOT NULL,
    password   VARCHAR(255) NOT NULL,
    is_admin   SMALLINT NOT NULL DEFAULT 0,
    role       VARCHAR(20) NOT NULL DEFAULT 'student'
               CHECK (role IN ('student', 'shop_admin', 'super_admin')),
    is_active  SMALLINT NOT NULL DEFAULT 1,
    shop_id    INTEGER NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shops (
    id              SERIAL PRIMARY KEY,
    shop_name       VARCHAR(255) NOT NULL DEFAULT 'Campus Print',
    owner_user_id   INTEGER NULL REFERENCES users(id) ON DELETE SET NULL,
    owner_name      VARCHAR(255) NULL,
    phone           VARCHAR(30) NULL,
    email           VARCHAR(255) NULL,
    address         VARCHAR(500) NULL,
    opens_at        TIME NULL,
    closes_at       TIME NULL,
    is_open         SMALLINT NOT NULL DEFAULT 1,
    approval_status VARCHAR(20) NOT NULL DEFAULT 'approved'
                    CHECK (approval_status IN ('pending', 'approved', 'rejected')),
    is_active       SMALLINT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users
    DROP CONSTRAINT IF EXISTS users_shop_id_fkey;
ALTER TABLE users
    ADD CONSTRAINT users_shop_id_fkey
    FOREIGN KEY (shop_id) REFERENCES shops(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS orders (
    id                      SERIAL PRIMARY KEY,
    user_id                 INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shop_id                 INTEGER NULL REFERENCES shops(id) ON DELETE SET NULL,
    status                  VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','accepted','printing','ready','completed','rejected','cancelled')),
    color_option            VARCHAR(10) DEFAULT 'bw' CHECK (color_option IN ('bw','color')),
    paper_size              VARCHAR(4) DEFAULT 'A4' CHECK (paper_size IN ('A4','A3')),
    copies                  INTEGER DEFAULT 1,
    spiral_binding          SMALLINT DEFAULT 0,
    express_delivery        SMALLINT DEFAULT 0,
    total_price             NUMERIC(10,2) DEFAULT 0.00,
    file_count              INTEGER DEFAULT 0,
    rejection_reason        VARCHAR(500) NULL,
    collection_location_id  VARCHAR(50) NULL,
    collection_location     VARCHAR(100) NULL,
    collection_time         VARCHAR(20) NULL,
    ticket_number           VARCHAR(20) NULL,
    total_pages             INTEGER NULL,
    printing_side           VARCHAR(10) NOT NULL DEFAULT 'single' CHECK (printing_side IN ('single','double')),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at);
CREATE INDEX IF NOT EXISTS idx_orders_shop_id ON orders (shop_id);
CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders (user_id);

CREATE TABLE IF NOT EXISTS order_files (
    id              SERIAL PRIMARY KEY,
    order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    original_name   VARCHAR(255) NOT NULL,
    stored_name     VARCHAR(255) NOT NULL,
    storage_path    TEXT NULL,
    mime_type       VARCHAR(100) NOT NULL,
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    file_deleted_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_order_files_created_at ON order_files (created_at);
CREATE INDEX IF NOT EXISTS idx_order_files_storage_path ON order_files (storage_path);

CREATE TABLE IF NOT EXISTS payments (
    id              SERIAL PRIMARY KEY,
    order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shop_id         INTEGER NULL,
    amount          NUMERIC(10,2) NOT NULL DEFAULT 0.00,
    status          VARCHAR(20) NOT NULL DEFAULT 'success'
                    CHECK (status IN ('pending','success','failed','refunded')),
    method          VARCHAR(50) NOT NULL DEFAULT 'manual',
    transaction_ref VARCHAR(100) DEFAULT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_status ON payments (status);

ALTER TABLE payments ADD COLUMN IF NOT EXISTS gateway_order_id VARCHAR(100);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_gateway_order_id ON payments (gateway_order_id);

-- Payment options (server/migrate_payment_options.js): shop's WhatsApp/UPI QR image,
-- and payment rows for guest orders (no user account).
ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_qr_path VARCHAR(500);
ALTER TABLE shops ADD COLUMN IF NOT EXISTS payment_qr_mime VARCHAR(100);
ALTER TABLE payments ALTER COLUMN user_id DROP NOT NULL;

INSERT INTO shops (id, shop_name)
SELECT 1, 'Campus Print'
WHERE NOT EXISTS (SELECT 1 FROM shops WHERE id = 1);

SELECT setval('shops_id_seq', GREATEST((SELECT MAX(id) FROM shops), 1));

-- App traffic uses the Express backend (service role / database URL), not the anon key.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deny_anon_users ON users;
DROP POLICY IF EXISTS deny_anon_shops ON shops;
DROP POLICY IF EXISTS deny_anon_orders ON orders;
DROP POLICY IF EXISTS deny_anon_order_files ON order_files;
DROP POLICY IF EXISTS deny_anon_payments ON payments;

CREATE TABLE IF NOT EXISTS student_profiles (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    full_name       VARCHAR(255) NOT NULL,
    phone_number    VARCHAR(30) NOT NULL,
    class_room_number VARCHAR(50) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_student_profiles_user_id ON student_profiles (user_id);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS student_id INTEGER REFERENCES student_profiles(id) ON DELETE SET NULL;
