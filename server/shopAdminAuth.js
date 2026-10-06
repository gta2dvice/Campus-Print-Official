const User = require('./models/User');
const bcrypt = require('bcryptjs');
const pool = require('./db');

function configuredAdminEmail() {
    return String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
}

function configuredAdminPassword() {
    return String(process.env.ADMIN_PASSWORD || '').trim();
}

async function ensureShopAdmin() {
    const email = configuredAdminEmail();
    const password = configuredAdminPassword();
    if (!email || !password) return null;

    const existing = await User.findByEmail(email);
    if (existing) {
        if (existing.role === 'shop_admin' && existing.is_active) return existing;
        return existing;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await pool.execute(
        `INSERT INTO users (email, password, is_admin, role, shop_id, is_active)
         VALUES (?, ?, 1, 'shop_admin', 1, 1)
         ON CONFLICT (email) DO UPDATE SET is_admin = 1, role = 'shop_admin', shop_id = COALESCE(users.shop_id, 1)`,
        [email, hashedPassword]
    );
    await pool.execute(
        `UPDATE shops SET owner_user_id = (SELECT id FROM users WHERE email = ?) WHERE id = 1 AND owner_user_id IS NULL`,
        [email]
    );
    return User.findByEmail(email);
}

async function authenticateShopAdmin(password) {
    const submitted = String(password || '');
    if (!submitted) {
        return { ok: false, status: 400, message: 'Please provide a password' };
    }

    const email = configuredAdminEmail();
    if (!email || !configuredAdminPassword()) {
        return { ok: false, status: 503, message: 'Admin login is not configured' };
    }

    await ensureShopAdmin();
    const user = await User.findByEmail(email);
    const activeShopAdmin = user && user.role === 'shop_admin' && user.is_active;
    let passwordOk = activeShopAdmin && (await User.matchPassword(submitted, user.password));

    // Env values used to be stored with accidental leading spaces. If the live
    // configured password matches, resync the hash without logging the secret.
    if (!passwordOk && activeShopAdmin && submitted === configuredAdminPassword()) {
        await User.updatePassword(user.id, submitted);
        passwordOk = true;
    }

    if (!passwordOk) {
        return { ok: false, status: 401, message: 'Invalid password' };
    }

    return { ok: true, user: await User.findByEmail(email) };
}

module.exports = {
    configuredAdminEmail,
    ensureShopAdmin,
    authenticateShopAdmin
};
