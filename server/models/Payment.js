const pool = require('../db');

// Payment rows are created by models/Order.js (with their order) and only ever
// marked successful by services/paymentFinalizer.js.

async function findByReference(paymentReference) {
    if (!paymentReference) return null;
    const [rows] = await pool.execute(
        `SELECT * FROM payments WHERE payment_reference = ? ORDER BY id DESC LIMIT 1`,
        [paymentReference]
    );
    return rows[0] || null;
}

// Refreshes the QR expiry for an unpaid payment (reuses the same order/reference).
async function refreshQrExpiry(orderId, qrExpiresAt) {
    await pool.execute(
        `UPDATE payments SET qr_expires_at = ?, updated_at = NOW() WHERE order_id = ? AND status = 'pending'`,
        [qrExpiresAt, orderId]
    );
    return findByOrderId(orderId);
}

async function findByGatewayOrderId(gatewayOrderId) {
    if (!gatewayOrderId) return null;
    const [rows] = await pool.execute(
        `SELECT * FROM payments WHERE gateway_order_id = ? ORDER BY id DESC LIMIT 1`,
        [gatewayOrderId]
    );
    return rows[0] || null;
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
         LEFT JOIN users u ON u.id = p.user_id
         LEFT JOIN shops s ON s.id = p.shop_id
         ${whereClause} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    const [[{ count }]] = await pool.query(
        `SELECT COUNT(*) AS count FROM payments p LEFT JOIN users u ON u.id = p.user_id ${whereClause}`,
        params
    );
    return { payments: rows, total: count, page, limit };
}

/**
 * Printer Admin "transactions": one row per settled payment of this shop's orders,
 * showing the PRINTER'S payable (the order's printing charges) — never the payment
 * amount the customer paid. Unpaid / failed attempts are not listed.
 * `amount` is null for orders placed before charges were itemised.
 */
async function listPrinterPayables({ search = '', status = '', shopId, dateFrom = '', dateTo = '', page = 1, limit = 20 } = {}) {
    const offset = (page - 1) * limit;
    const where = ["p.status IN ('success', 'refunded')", 'o.shop_id = ?'];
    const params = [shopId];

    if (search) { where.push('(p.transaction_ref LIKE ? OR u.email LIKE ? OR o.guest_full_name LIKE ? OR p.order_id = ?)'); params.push(`%${search}%`, `%${search}%`, `%${search}%`, Number(search) || 0); }
    if (status === 'success' || status === 'refunded') { where.push('p.status = ?'); params.push(status); }
    if (dateFrom) { where.push('p.created_at >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('p.created_at <= ?'); params.push(`${dateTo} 23:59:59`); }
    const whereClause = `WHERE ${where.join(' AND ')}`;

    const [rows] = await pool.query(
        `SELECT p.id, p.order_id, p.status, p.method, p.transaction_ref, p.created_at,
                COALESCE(u.email, o.guest_full_name) AS customer_email,
                o.ticket_number, o.printing_amount AS amount
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         LEFT JOIN users u ON u.id = o.user_id
         ${whereClause} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    const [[{ count }]] = await pool.query(
        `SELECT COUNT(*) AS count FROM payments p JOIN orders o ON o.id = p.order_id
         LEFT JOIN users u ON u.id = o.user_id ${whereClause}`,
        params
    );
    return {
        payments: rows.map(r => ({ ...r, amount: r.amount === null ? null : parseFloat(r.amount) })),
        total: count,
        page,
        limit
    };
}

/** Every payment attempt for one order (Super Admin breakdown). */
async function listForOrder(orderId) {
    const [rows] = await pool.execute(
        `SELECT id, status, method, amount, currency, transaction_ref, gateway_order_id, payment_reference,
                paid_at, created_at, updated_at
         FROM payments WHERE order_id = ? ORDER BY id`,
        [orderId]
    );
    return rows;
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

module.exports = { refundForOrder, findByOrderId, listPayments, listPrinterPayables, listForOrder, getPlatformPaymentStats, findByGatewayOrderId, findByReference, refreshQrExpiry };
