const pool = require('../db');
const Profile = require('./Profile');

// Canonical payment method stored on the order, keyed by the legacy lowercase
// payments.method value. Cashfree and UPI QR are the student-facing methods;
// WHATSAPP / PAY_AT_SHOP are legacy manual orders; SIMULATED is dev-only.
const ORDER_PAYMENT_METHOD = {
    cashfree: 'CASHFREE',
    upi_qr: 'UPI_QR',
    whatsapp: 'WHATSAPP',
    none: 'PAY_AT_SHOP',
    simulated: 'SIMULATED'
};

// Payments a shop admin may confirm by hand (no gateway can verify them).
const ADMIN_CONFIRMABLE_METHODS = ['upi_qr', 'whatsapp', 'none'];

// Orders the shop works with: paid orders, plus manual-payment orders still awaiting
// the admin's confirmation. Unpaid / failed Cashfree checkouts stay hidden.
const SHOP_VISIBLE_ORDER = `(o.payment_status = 'PAID' OR (o.payment_status = 'PAYMENT_PENDING' AND EXISTS (
    SELECT 1 FROM payments op
    WHERE op.order_id = o.id AND op.status = 'pending'
      AND op.method IN (${ADMIN_CONFIRMABLE_METHODS.map(m => `'${m}'`).join(', ')}))))`;

/**
 * Creates ONE internal order together with its first payment attempt, atomically.
 * Every order starts PAYMENT_PENDING with no ticket; it only becomes PAID (and gets
 * a ticket) through services/paymentFinalizer.
 *
 * payment: { method, gatewayOrderId?, qrExpiresAt?, referenceFor?(orderId) }
 *   referenceFor builds an order-scoped payment reference (UPI QR) inside the
 *   same transaction; it is stored as both payment_reference and transaction_ref.
 * Returns { id, paymentId, paymentReference }.
 */
async function createOrder(userId, shopId, data, { payment, ticketTokenHash = null }) {
    const {
        paperSize, copies, spiralBinding, expressDelivery, totalPrice, fileCount,
        collectionLocationId, collectionLocationName, collectionTime, collectionDate, totalPages,
        guestFullName, guestPhone, guestClassroom
    } = data;
    const orderPaymentMethod = ORDER_PAYMENT_METHOD[payment.method];
    if (!orderPaymentMethod) throw new Error(`Unknown payment method: ${payment.method}`);

    let studentId = null;
    if (userId) {
        const profile = await Profile.getProfileByUserId(userId);
        studentId = profile ? profile.id : null;
    }

    return pool.transaction(async tx => {
        const [result] = await tx.execute(
            `INSERT INTO orders
            (user_id, student_id, shop_id, paper_size, copies, spiral_binding, express_delivery, total_price, file_count,
             collection_location_id, collection_location, collection_time, total_pages,
             collection_date,
             guest_full_name, guest_phone, guest_classroom, payment_status, payment_method, ticket_status,
             ticket_access_token_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAYMENT_PENDING', ?, 'PENDING_PAYMENT', ?)
         RETURNING id`,
            [
                userId || null,
                studentId,
                shopId,
                paperSize || 'A4',
                copies || 1,
                spiralBinding ? 1 : 0,
                expressDelivery ? 1 : 0,
                totalPrice || 0,
                fileCount || 0,
                collectionLocationId || null,
                collectionLocationName || null,
                collectionTime || null,
                totalPages || 0,
                collectionDate || null,
                guestFullName || null,
                guestPhone || null,
                guestClassroom || null,
                orderPaymentMethod,
                ticketTokenHash
            ]
        );
        const id = result.insertId;
        const paymentReference = payment.referenceFor ? payment.referenceFor(id) : null;
        const paymentId = await insertPaymentAttempt(tx, id, userId, shopId, totalPrice, {
            ...payment,
            paymentReference,
            transactionRef: paymentReference
        });
        return { id, paymentId, paymentReference };
    });
}

async function insertPaymentAttempt(tx, orderId, userId, shopId, amount, payment) {
    const [result] = await tx.execute(
        `INSERT INTO payments
            (order_id, user_id, shop_id, amount, currency, status, method, transaction_ref,
             gateway_order_id, payment_reference, qr_expires_at)
         VALUES (?, ?, ?, ?, 'INR', 'pending', ?, ?, ?, ?, ?)
         RETURNING id`,
        [
            orderId,
            userId || null,
            shopId,
            amount || 0,
            payment.method,
            payment.transactionRef || null,
            payment.gatewayOrderId || null,
            payment.paymentReference || null,
            payment.qrExpiresAt || null
        ]
    );
    return result.insertId;
}

/**
 * Adds a new Cashfree attempt to an existing unpaid order (retry after a failed
 * or abandoned checkout) — the order, its files and amount stay the same.
 * Returns null when the order is already paid or still has an open attempt.
 */
async function addCashfreeAttempt(orderId, { gatewayOrderId, ticketTokenHash }) {
    return pool.transaction(async tx => {
        const [orderRows] = await tx.query(
            `SELECT id, user_id, shop_id, total_price, payment_status FROM orders WHERE id = ? FOR UPDATE`,
            [orderId]
        );
        const order = orderRows[0];
        if (!order || order.payment_status === 'PAID') return null;
        const [open] = await tx.query(
            `SELECT 1 FROM payments WHERE order_id = ? AND status IN ('pending', 'success') LIMIT 1`,
            [orderId]
        );
        if (open.length) return null;

        const paymentId = await insertPaymentAttempt(tx, order.id, order.user_id, order.shop_id, order.total_price, {
            method: 'cashfree',
            gatewayOrderId
        });
        // The ticket link is derived from the attempt that ends up paying.
        await tx.execute(
            `UPDATE orders SET payment_status = 'PAYMENT_PENDING', ticket_access_token_hash = ? WHERE id = ?`,
            [ticketTokenHash, order.id]
        );
        return { id: order.id, paymentId, amount: Number(order.total_price) };
    });
}

async function getPaymentIntentByGatewayOrderId(gatewayOrderId) {
    const [rows] = await pool.execute(
        `SELECT p.id AS payment_id, p.order_id, p.amount AS payment_amount, p.currency AS payment_currency,
                p.status AS payment_status, p.transaction_ref, p.gateway_order_id,
                o.total_price, o.payment_status AS order_payment_status, o.ticket_status,
                o.ticket_number, o.ticket_access_token_hash, o.user_id, o.guest_full_name, o.guest_phone
         FROM payments p
         JOIN orders o ON o.id = p.order_id
         WHERE p.gateway_order_id = ? LIMIT 1`,
        [gatewayOrderId]
    );
    return rows[0] || null;
}

/** Latest Cashfree attempt for an order (used to re-check a pending order). */
async function getLatestCashfreeAttempt(orderId) {
    const [rows] = await pool.execute(
        `SELECT * FROM payments WHERE order_id = ? AND method = 'cashfree' ORDER BY id DESC LIMIT 1`,
        [orderId]
    );
    return rows[0] || null;
}

/**
 * Marks one payment attempt failed. The order only becomes PAYMENT_FAILED when no
 * other attempt is still open, so a late failure event can neither downgrade a
 * paid order nor clobber a newer retry.
 */
async function failPaymentAttempt(paymentId) {
    return pool.transaction(async tx => {
        const [paymentRows] = await tx.query(`SELECT order_id FROM payments WHERE id = ?`, [paymentId]);
        if (!paymentRows[0]) return false;
        const orderId = paymentRows[0].order_id;
        // Same lock order as the finalizer (order, then payment) to avoid deadlocks.
        await tx.query(`SELECT id FROM orders WHERE id = ? FOR UPDATE`, [orderId]);
        const [rows] = await tx.query(`SELECT id, status FROM payments WHERE id = ? FOR UPDATE`, [paymentId]);
        const payment = rows[0];
        if (!payment || payment.status !== 'pending') return false;
        await tx.execute(
            `UPDATE payments SET status = 'failed', updated_at = NOW() WHERE id = ? AND status = 'pending'`,
            [payment.id]
        );
        await tx.execute(
            `UPDATE orders SET payment_status = 'PAYMENT_FAILED'
             WHERE id = ? AND payment_status = 'PAYMENT_PENDING'
               AND NOT EXISTS (SELECT 1 FROM payments WHERE order_id = ? AND status IN ('pending', 'success'))`,
            [orderId, orderId]
        );
        return true;
    });
}

/** Marks a Cashfree attempt (by its gateway order id) failed. */
async function failPayment(gatewayOrderId) {
    const [rows] = await pool.execute(`SELECT id FROM payments WHERE gateway_order_id = ?`, [gatewayOrderId]);
    return rows[0] ? failPaymentAttempt(rows[0].id) : false;
}

/** Latest pending payment a shop admin may confirm by hand, or null. */
async function getAdminConfirmablePayment(orderId) {
    const [rows] = await pool.execute(
        `SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
        [orderId]
    );
    const payment = rows[0];
    if (!payment || payment.status !== 'pending' || !ADMIN_CONFIRMABLE_METHODS.includes(payment.method)) {
        return null;
    }
    return payment;
}

/** Unfiltered order lookup for student-facing routes; callers MUST authorize access. */
async function getOrderRecord(orderId) {
    const [rows] = await pool.execute(
        `SELECT o.*, u.email AS customer_email
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
         WHERE o.id = ?`,
        [orderId]
    );
    return rows[0] || null;
}

async function getOrderForUser(orderId, userId) {
    const [rows] = await pool.execute(
        `SELECT o.*, u.email AS customer_email, p.full_name, p.phone_number, p.class_room_number
         FROM orders o
         JOIN users u ON u.id = o.user_id
         LEFT JOIN student_profiles p ON p.id = o.student_id
         WHERE o.id = ? AND o.user_id = ? AND o.payment_status = 'PAID'`,
        [orderId, userId]
    );
    return rows[0] || null;
}

async function getOrdersByUser(userId) {
    const [rows] = await pool.execute(
        `SELECT o.*, p.full_name, p.phone_number, p.class_room_number
         FROM orders o
         LEFT JOIN student_profiles p ON p.id = o.student_id
         WHERE o.user_id = ? AND o.payment_status = 'PAID' ORDER BY o.created_at DESC LIMIT 50`,
        [userId]
    );
    return rows;
}

// Guest order recovery: all orders for a normalized phone (any payment method or
// state), newest first, each with its latest payment attempt. Primary key stays orders.id; guest_phone is
// only an indexed lookup field (one phone → many orders).
async function getGuestOrdersByPhone(phone) {
    const [rows] = await pool.execute(
        `SELECT o.*,
                pay.status            AS latest_payment_status,
                pay.method            AS latest_payment_method,
                pay.qr_expires_at     AS latest_qr_expires_at,
                pay.gateway_order_id  AS latest_gateway_order_id
         FROM orders o
         LEFT JOIN LATERAL (
             SELECT status, method, qr_expires_at, gateway_order_id
             FROM payments WHERE order_id = o.id ORDER BY id DESC LIMIT 1
         ) pay ON true
         WHERE o.guest_phone = ?
         ORDER BY o.created_at DESC
         LIMIT 50`,
        [phone]
    );
    return rows;
}

async function getOrderStats(userId) {
    const [rows] = await pool.execute(
        `SELECT status, COUNT(*) AS count FROM orders
         WHERE user_id = ? AND payment_status = 'PAID' GROUP BY status`,
        [userId]
    );
    const result = { total: 0, in_progress: 0, ready: 0 };
    rows.forEach(r => {
        const cnt = parseInt(r.count, 10);
        result.total += cnt;
        if (r.status === 'accepted' || r.status === 'printing') result.in_progress += cnt;
        if (r.status === 'ready' || r.status === 'completed') result.ready += cnt;
    });
    return result;
}

// ── Shop Admin: order management ─────────────────

const VALID_STATUSES = ['pending', 'accepted', 'printing', 'ready', 'completed', 'rejected', 'cancelled'];

// Allowed forward transitions a shop admin can make from the current status
const ALLOWED_TRANSITIONS = {
    pending: ['accepted', 'rejected'],
    accepted: ['printing', 'cancelled'],
    printing: ['ready', 'cancelled'],
    ready: ['completed', 'cancelled'],
    completed: [],
    rejected: [],
    cancelled: []
};

async function listOrders({ search = '', status = '', shopId = null, dateFrom = '', dateTo = '', page = 1, limit = 20, sort = 'created_at', dir = 'DESC' } = {}) {
    const offset = (page - 1) * limit;
    const where = [SHOP_VISIBLE_ORDER];
    const params = [];

    if (shopId) {
        where.push('o.shop_id = ?');
        params.push(shopId);
    }
    if (search) {
        where.push('(o.id = ? OR u.email LIKE ? OR p.full_name LIKE ? OR o.guest_full_name LIKE ?)');
        params.push(Number(search) || 0, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
        where.push('o.status = ?');
        params.push(status);
    }
    if (dateFrom) {
        where.push('o.created_at >= ?');
        params.push(dateFrom);
    }
    if (dateTo) {
        where.push('o.created_at <= ?');
        params.push(`${dateTo} 23:59:59`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sortableColumns = { created_at: 'o.created_at', total_price: 'o.total_price', status: 'o.status' };
    const sortCol = sortableColumns[sort] || 'o.created_at';
    const sortDir = dir === 'ASC' ? 'ASC' : 'DESC';

    const [rows] = await pool.query(
        `SELECT o.*, u.email AS customer_email, s.shop_name, p.full_name, p.phone_number, p.class_room_number
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
         LEFT JOIN shops s ON s.id = o.shop_id
         LEFT JOIN student_profiles p ON p.id = o.student_id
         ${whereClause}
         ORDER BY ${sortCol} ${sortDir}
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    const [[{ count }]] = await pool.query(
        `SELECT COUNT(*) AS count FROM orders o
         LEFT JOIN users u ON u.id = o.user_id
         LEFT JOIN student_profiles p ON p.id = o.student_id
         ${whereClause}`,
        params
    );
    return { orders: rows, total: count, page, limit };
}

async function getOrderById(orderId, shopId = null) {
    const params = [orderId];
    let shopFilter = '';
    if (shopId) { shopFilter = 'AND o.shop_id = ?'; params.push(shopId); }
    const [rows] = await pool.execute(
        `SELECT o.*, u.email AS customer_email, s.shop_name, p.full_name, p.phone_number, p.class_room_number
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
         LEFT JOIN shops s ON s.id = o.shop_id
         LEFT JOIN student_profiles p ON p.id = o.student_id
         WHERE o.id = ? AND ${SHOP_VISIBLE_ORDER} ${shopFilter}`,
        params
    );
    return rows[0] || null;
}

async function getOrderByTicketTokenHash(tokenHash) {
    const [rows] = await pool.execute(
        `SELECT o.*, u.email AS customer_email, s.shop_name, p.full_name, p.phone_number, p.class_room_number
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
         LEFT JOIN shops s ON s.id = o.shop_id
         LEFT JOIN student_profiles p ON p.id = o.student_id
         WHERE o.ticket_access_token_hash = ?`,
        [tokenHash]
    );
    return rows[0] || null;
}

async function updateStatus(orderId, newStatus, rejectionReason = null, shopId = null) {
    const order = await getOrderById(orderId, shopId);
    if (!order) return { error: 'not_found' };

    const allowed = ALLOWED_TRANSITIONS[order.status] || [];
    if (!allowed.includes(newStatus)) {
        return { error: 'invalid_transition', from: order.status, to: newStatus };
    }

    if (newStatus === 'rejected') {
        await pool.execute(
            'UPDATE orders SET status = ?, rejection_reason = ? WHERE id = ?',
            [newStatus, rejectionReason || null, orderId]
        );
    } else {
        await pool.execute('UPDATE orders SET status = ? WHERE id = ?', [newStatus, orderId]);
    }
    return { order: await getOrderById(orderId, shopId) };
}

async function getDashboardStats(shopId = null) {
    const shopFilter = shopId ? ' AND shop_id = ?' : '';
    const shopParams = shopId ? [shopId] : [];

    const [statusRows] = await pool.query(
        `SELECT status, COUNT(*) AS count FROM orders WHERE payment_status = 'PAID' ${shopFilter} GROUP BY status`,
        shopParams
    );
    const counts = { pending: 0, accepted: 0, printing: 0, ready: 0, completed: 0, rejected: 0, cancelled: 0 };
    statusRows.forEach(r => { counts[r.status] = parseInt(r.count, 10); });

    const [[todayRow]] = await pool.query(
        `SELECT COUNT(*) AS orders_today, COALESCE(SUM(total_price), 0) AS earnings_today
         FROM orders WHERE payment_status = 'PAID' AND DATE(created_at) = CURDATE()
           AND status NOT IN ('rejected','cancelled') ${shopFilter}`,
        shopParams
    );
    const [[totalRow]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS total_earnings FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed' ${shopFilter}`,
        shopParams
    );
    const recentFilter = shopId ? ' AND o.shop_id = ?' : '';
    const [recentOrders] = await pool.query(
        `SELECT o.*, u.email AS customer_email FROM orders o LEFT JOIN users u ON u.id = o.user_id
         WHERE o.payment_status = 'PAID' ${recentFilter} ORDER BY o.created_at DESC LIMIT 5`,
        shopParams
    );

    return {
        totalOrders: Object.values(counts).reduce((a, b) => a + b, 0),
        statusCounts: counts,
        ordersToday: parseInt(todayRow.orders_today, 10),
        earningsToday: parseFloat(todayRow.earnings_today),
        totalEarnings: parseFloat(totalRow.total_earnings),
        recentOrders
    };
}

async function getEarnings(shopId = null) {
    const shopFilter = shopId ? 'AND shop_id = ?' : '';
    const shopParams = shopId ? [shopId] : [];

    const [[today]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS amount, COUNT(*) AS count FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed' AND DATE(created_at) = CURDATE() ${shopFilter}`, shopParams
    );
    const [[yesterday]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS amount, COUNT(*) AS count FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed' AND DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY) ${shopFilter}`, shopParams
    );
    const [[week]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS amount, COUNT(*) AS count FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed' AND YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1) ${shopFilter}`, shopParams
    );
    const [[month]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS amount, COUNT(*) AS count FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed' AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE()) ${shopFilter}`, shopParams
    );
    const [[total]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS amount, COUNT(*) AS count FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed' ${shopFilter}`, shopParams
    );
    const [trend] = await pool.query(
        `SELECT DATE(created_at) AS date, COALESCE(SUM(total_price), 0) AS amount
         FROM orders WHERE payment_status = 'PAID' AND status = 'completed'
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) ${shopFilter}
         GROUP BY DATE(created_at) ORDER BY date ASC`, shopParams
    );
    const txFilter = shopId ? 'AND o.shop_id = ?' : '';
    const [recentTransactions] = await pool.query(
        `SELECT o.id, o.total_price, o.created_at, u.email AS customer_email
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
         WHERE o.payment_status = 'PAID' AND o.status = 'completed' ${txFilter} ORDER BY o.created_at DESC LIMIT 10`, shopParams
    );

    const avgOrderValue = total.count > 0 ? parseFloat(total.amount) / parseInt(total.count, 10) : 0;

    return {
        today: { amount: parseFloat(today.amount), count: parseInt(today.count, 10) },
        yesterday: { amount: parseFloat(yesterday.amount), count: parseInt(yesterday.count, 10) },
        week: { amount: parseFloat(week.amount), count: parseInt(week.count, 10) },
        month: { amount: parseFloat(month.amount), count: parseInt(month.count, 10) },
        total: { amount: parseFloat(total.amount), count: parseInt(total.count, 10) },
        avgOrderValue,
        trend: trend.map(r => ({ date: r.date, amount: parseFloat(r.amount) })),
        recentTransactions
    };
}

// ── Super Admin: platform-wide ───────────────────

async function getPlatformStats() {
    const [statusRows] = await pool.query(
        `SELECT status, COUNT(*) AS count FROM orders WHERE payment_status = 'PAID' GROUP BY status`
    );
    const counts = { pending: 0, accepted: 0, printing: 0, ready: 0, completed: 0, rejected: 0, cancelled: 0 };
    statusRows.forEach(r => { counts[r.status] = parseInt(r.count, 10); });

    const [[revenueRow]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS revenue FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed'`
    );
    const [ordersOverTime] = await pool.query(
        `SELECT DATE(created_at) AS date, COUNT(*) AS count
         FROM orders WHERE payment_status = 'PAID' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
         GROUP BY DATE(created_at) ORDER BY date ASC`
    );

    return {
        totalOrders: Object.values(counts).reduce((a, b) => a + b, 0),
        statusCounts: counts,
        totalRevenue: parseFloat(revenueRow.revenue),
        ordersOverTime: ordersOverTime.map(r => ({ date: r.date, count: parseInt(r.count, 10) }))
    };
}

module.exports = {
    ORDER_PAYMENT_METHOD,
    ADMIN_CONFIRMABLE_METHODS,
    createOrder,
    addCashfreeAttempt,
    getPaymentIntentByGatewayOrderId,
    getLatestCashfreeAttempt,
    failPayment,
    failPaymentAttempt,
    getAdminConfirmablePayment,
    getOrderRecord,
    getOrderForUser,
    getOrdersByUser,
    getGuestOrdersByPhone,
    getOrderStats,
    VALID_STATUSES,
    ALLOWED_TRANSITIONS,
    listOrders,
    getOrderById,
    getOrderByTicketTokenHash,
    updateStatus,
    getDashboardStats,
    getEarnings,
    getPlatformStats
};
