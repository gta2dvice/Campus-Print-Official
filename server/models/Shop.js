const pool = require('../db');

async function getShopById(id) {
    const [rows] = await pool.execute('SELECT * FROM shops WHERE id = ?', [id]);
    return rows[0] || null;
}

async function getShopByOwner(userId) {
    const [rows] = await pool.execute('SELECT * FROM shops WHERE owner_user_id = ?', [userId]);
    return rows[0] || null;
}

async function listShops({ search = '', status = '', page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;
    const where = [];
    const params = [];

    if (search) {
        where.push('shop_name LIKE ?');
        params.push(`%${search}%`);
    }
    if (status === 'active') where.push('is_active = 1');
    if (status === 'inactive') where.push('is_active = 0');
    if (status === 'pending') where.push("approval_status = 'pending'");

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
        `SELECT s.*, u.email AS owner_email,
                (SELECT COUNT(*) FROM orders o WHERE o.shop_id = s.id) AS total_orders,
                (SELECT COALESCE(SUM(total_price), 0) FROM orders o WHERE o.shop_id = s.id AND o.status = 'completed') AS total_earnings
         FROM shops s LEFT JOIN users u ON u.id = s.owner_user_id
         ${whereClause} ORDER BY s.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    const [[{ count }]] = await pool.query(`SELECT COUNT(*) AS count FROM shops s ${whereClause}`, params);
    return { shops: rows, total: count, page, limit };
}

async function updateShop(id, data) {
    const fields = ['shop_name', 'owner_name', 'phone', 'email', 'address', 'opens_at', 'closes_at', 'is_open'];
    const updates = [];
    const params = [];

    fields.forEach(f => {
        if (Object.prototype.hasOwnProperty.call(data, f)) {
            updates.push(`${f} = ?`);
            params.push(data[f]);
        }
    });

    if (updates.length === 0) return getShopById(id);

    params.push(id);
    await pool.execute(`UPDATE shops SET ${updates.join(', ')} WHERE id = ?`, params);
    return getShopById(id);
}

async function setPaymentQr(id, storagePath, mimeType) {
    await pool.execute('UPDATE shops SET payment_qr_path = ?, payment_qr_mime = ? WHERE id = ?', [storagePath, mimeType, id]);
    return getShopById(id);
}

async function setApprovalStatus(id, status) {
    await pool.execute('UPDATE shops SET approval_status = ? WHERE id = ?', [status, id]);
    return getShopById(id);
}

async function setActive(id, isActive) {
    await pool.execute('UPDATE shops SET is_active = ? WHERE id = ?', [isActive ? 1 : 0, id]);
    return getShopById(id);
}

async function getPlatformShopStats() {
    const [[row]] = await pool.query(
        `SELECT COUNT(*) AS total, SUM(is_active) AS active,
                SUM(CASE WHEN approval_status = 'pending' THEN 1 ELSE 0 END) AS pending FROM shops`
    );
    return {
        total: parseInt(row.total, 10),
        active: parseInt(row.active, 10) || 0,
        pending: parseInt(row.pending, 10) || 0
    };
}

module.exports = {
    getShopById,
    getShopByOwner,
    listShops,
    updateShop,
    setPaymentQr,
    setApprovalStatus,
    setActive,
    getPlatformShopStats
};
