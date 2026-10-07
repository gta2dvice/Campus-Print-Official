const pool = require('../db');
const bcrypt = require('bcryptjs');

const ADMIN_ROLES = ['shop_admin', 'super_admin'];

async function createUser(email, password) {
    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await pool.execute(
        'INSERT INTO users (email, password) VALUES (?, ?)',
        [email.toLowerCase().trim(), hashedPassword]
    );
    return { id: result.insertId, email: email.toLowerCase().trim() };
}

async function findByEmail(email) {
    const [rows] = await pool.execute(
        'SELECT id, email, password, is_admin, role, is_active, shop_id, supabase_uid FROM users WHERE email = ?',
        [email.toLowerCase().trim()]
    );
    return rows[0] || null;
}

async function findById(id) {
    const [rows] = await pool.execute(
        'SELECT id, email, is_admin, role, is_active, shop_id, supabase_uid, created_at FROM users WHERE id = ?',
        [id]
    );
    return rows[0] || null;
}

async function findBySupabaseUid(supabaseUid) {
    if (!supabaseUid) return null;
    const [rows] = await pool.execute(
        'SELECT id, email, is_admin, role, is_active, shop_id, supabase_uid, created_at FROM users WHERE supabase_uid = ?',
        [supabaseUid]
    );
    return rows[0] || null;
}

async function upsertSupabaseUser({ supabaseUid, email }) {
    const normalizedEmail = (email || '').toLowerCase().trim();
    if (!supabaseUid || !normalizedEmail) return null;

    let user = await findBySupabaseUid(supabaseUid);
    if (user) {
        return user;
    }

    const [emailRows] = await pool.execute(
        'SELECT id, email, is_admin, role, is_active, shop_id, supabase_uid FROM users WHERE email = ?',
        [normalizedEmail]
    );
    if (emailRows[0]) {
        user = emailRows[0];
        // Admin accounts sign in to /admin and /super-admin with their password, so keep it;
        // only student accounts move over to Supabase-only login.
        const keepsPassword = ADMIN_ROLES.includes(user.role);
        await pool.execute(
            keepsPassword
                ? 'UPDATE users SET supabase_uid = ? WHERE id = ?'
                : 'UPDATE users SET supabase_uid = ?, password = NULL WHERE id = ?',
            [supabaseUid, user.id]
        );
        user.supabase_uid = supabaseUid;
        return user;
    }

    const [result] = await pool.execute(
        'INSERT INTO users (email, password, is_admin, role, is_active, supabase_uid) VALUES (?, NULL, 0, ?, 1, ?)',
        [normalizedEmail, 'student', supabaseUid]
    );
    return {
        id: result.insertId,
        email: normalizedEmail,
        is_admin: 0,
        role: 'student',
        is_active: 1,
        supabase_uid: supabaseUid
    };
}

async function matchPassword(plainPassword, hashedPassword) {
    if (!hashedPassword) return false;
    return await bcrypt.compare(plainPassword, hashedPassword);
}

async function updatePassword(userId, newPassword) {
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.execute('UPDATE users SET password = ? WHERE id = ?', [hashed, userId]);
}

// ── Super Admin: user management ─────────────────
async function listUsers({ search = '', role = '', page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;
    const where = [];
    const params = [];

    if (search) {
        where.push('email LIKE ?');
        params.push(`%${search}%`);
    }
    if (role) {
        where.push('role = ?');
        params.push(role);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
        `SELECT id, email, role, is_active, created_at, supabase_uid FROM users
         ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    const [[{ count }]] = await pool.query(
        `SELECT COUNT(*) AS count FROM users ${whereClause}`,
        params
    );
    return { users: rows, total: count, page, limit };
}

async function setActive(userId, isActive) {
    await pool.execute('UPDATE users SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, userId]);
    return findById(userId);
}

async function getPlatformUserStats() {
    const [rows] = await pool.query(
        `SELECT role, COUNT(*) AS count, SUM(is_active) AS active_count FROM users GROUP BY role`
    );
    const result = { totalStudents: 0, activeStudents: 0, totalShopAdmins: 0, totalSuperAdmins: 0 };
    rows.forEach(r => {
        if (r.role === 'student') {
            result.totalStudents = parseInt(r.count, 10);
            result.activeStudents = parseInt(r.active_count, 10) || 0;
        }
        if (r.role === 'shop_admin') result.totalShopAdmins = parseInt(r.count, 10);
        if (r.role === 'super_admin') result.totalSuperAdmins = parseInt(r.count, 10);
    });
    return result;
}

module.exports = {
    createUser,
    findByEmail,
    findById,
    findBySupabaseUid,
    upsertSupabaseUser,
    matchPassword,
    updatePassword,
    listUsers,
    setActive,
    getPlatformUserStats
};
