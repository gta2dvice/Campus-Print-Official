const pool = require('../db');

async function createForOrder(orderId, userId, shopId, amount, method = 'manual', transactionRef = null, extra = {}) {
    const ref = transactionRef || `TXN-${String(orderId).padStart(6, '0')}`;
    const status = extra.status || 'success';
    const gatewayOrderId = extra.gatewayOrderId || null;
    const [result] = await pool.execute(
        `INSERT INTO payments (order_id, user_id, shop_id, amount, status, method, transaction_ref, gateway_order_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, userId, shopId, amount, status, method, ref, gatewayOrderId]
    );
    return { id: result.insertId, transaction_ref: ref };
}

async function findByGatewayOrderId(gatewayOrderId) {
    if (!gatewayOrderId) return null;
    const [rows] = await pool.execute(
        `SELECT * FROM payments WHERE gateway_order_id = ? ORDER BY id DESC LIMIT 1`,
        [gatewayOrderId]
    );
    return rows[0] || null;
}

async function updateByGatewayOrderId(gatewayOrderId, { status, transactionRef } = {}) {
    const fields = [];
    const params = [];
    if (status) { fields.push('status = ?'); params.push(status); }
    if (transactionRef) { fields.push('transaction_ref = ?'); params.push(transactionRef); }
    if (fields.length === 0) return findByGatewayOrderId(gatewayOrderId);
    fields.push('updated_at = NOW()');
    params.push(gatewayOrderId);
    await pool.execute(
        `UPDATE payments SET ${fields.join(', ')} WHERE gateway_order_id = ?`,
        params
    );
    return findByGatewayOrderId(gatewayOrderId);
}

async function refundForOrder(orderId) {
    // Only money actually received can be refunded; an unpaid (pending) QR / pay-at-shop order stays pending.
    await pool.execute(`UPDATE payments SET status = 'refunded' WHERE order_id = ? AND status = 'success'`, [orderId]);
}

async function findByOrderId(orderId) {
    const [rows] = await pool.execute(
        `SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
        [orderId]
    );
    return rows[0] || null;
}

/** Marks an order's pending (offline) payment as received. Returns null when nothing was pending. */
async function markPaidForOrder(orderId) {
    const payment = await findByOrderId(orderId);
    if (!payment || payment.status !== 'pending') return null;
    await pool.execute(`UPDATE payments SET status = 'success', updated_at = NOW() WHERE id = ?`, [payment.id]);
    return findByOrderId(orderId);
}

async function listPayments({ search = '', status = '', shopId = null, dateFrom = '', dateTo = '', page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;
    const where = [];
    const params = [];

    if (shopId) { where.push('p.shop_id = ?'); params.push(shopId); }
    if (search) { where.push('(p.transaction_ref LIKE ? OR u.email LIKE ? OR p.order_id = ?)'); params.push(`%${search}%`, `%${search}%`, Number(search) || 0); }
    if (status) { where.push('p.status = ?'); params.push(status); }
    if (dateFrom) { where.push('p.created_at >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('p.created_at <= ?'); params.push(`${dateTo} 23:59:59`); }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [rows] = await pool.query(
        `SELECT p.*, u.email AS customer_email, s.shop_name
         FROM payments p
         JOIN users u ON u.id = p.user_id
         LEFT JOIN shops s ON s.id = p.shop_id
         ${whereClause} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    const [[{ count }]] = await pool.query(
        `SELECT COUNT(*) AS count FROM payments p JOIN users u ON u.id = p.user_id ${whereClause}`,
        params
    );
    return { payments: rows, total: count, page, limit };
}

async function getPlatformPaymentStats() {
    const [rows] = await pool.query('SELECT status, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount FROM payments GROUP BY status');
    const result = {
        total: { count: 0, amount: 0 },
        success: { count: 0, amount: 0 },
        failed: { count: 0, amount: 0 },
        pending: { count: 0, amount: 0 },
        refunded: { count: 0, amount: 0 }
    };
    rows.forEach(r => {
        result[r.status] = { count: parseInt(r.count, 10), amount: parseFloat(r.amount) };
        result.total.count += parseInt(r.count, 10);
        result.total.amount += parseFloat(r.amount);
    });
    result.successRate = result.total.count > 0
        ? ((result.success.count / result.total.count) * 100).toFixed(1)
        : '0.0';
    return result;
}

module.exports = { createForOrder, refundForOrder, findByOrderId, markPaidForOrder, listPayments, getPlatformPaymentStats, findByGatewayOrderId, updateByGatewayOrderId };
