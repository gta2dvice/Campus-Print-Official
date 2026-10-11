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
    // Itemised charge split, saved once at creation so the order keeps its own
    // historical amounts even if rates change later (server/pricing.js).
    const charges = data.charges || {};
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
             ticket_access_token_hash, printing_amount, service_charge, delivery_charge, classroom_charge)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAYMENT_PENDING', ?, 'PENDING_PAYMENT', ?, ?, ?, ?, ?)
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
                ticketTokenHash,
                charges.printingAmount ?? null,
                charges.serviceCharge ?? null,
                charges.deliveryCharge ?? null,
                charges.classroomCharge ?? null
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
        // Waiting for the printer (pending, or a legacy intermediate state) vs ready for pickup.
        if (['pending', 'accepted', 'printing'].includes(r.status)) result.in_progress += cnt;
        if (r.status === 'ready' || r.status === 'completed') result.ready += cnt;
    });
    return result;
}

// ── Shop Admin: order management ─────────────────

const VALID_STATUSES = ['pending', 'accepted', 'printing', 'ready', 'completed', 'rejected', 'cancelled'];

// Admin workflow: Pending → Accept → Completed (= Ready for Pickup), or Pending → Rejected.
// 'accepted' / 'printing' / 'ready' are legacy intermediate states (kept valid in the
// DB); any such order can only be completed or cancelled.
const ALLOWED_TRANSITIONS = {
    pending: ['completed', 'rejected'],
    accepted: ['completed', 'cancelled'],
    printing: ['completed', 'cancelled'],
    ready: ['completed', 'cancelled'],
    completed: [],
    rejected: [],
    cancelled: []
};

async function listOrders({ search = '', status = '', shopId = null, dateFrom = '', dateTo = '', page = 1, limit = 20, sort = 'created_at', dir = 'DESC', view = 'customer' } = {}) {
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

    // The printer's "amount" sort uses printing charges, never the customer total.
    const sortableColumns = { created_at: 'o.created_at', total_price: `o.${amountColumn(view)}`, status: 'o.status' };
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
    // Only paid orders can be accepted / handed over (never marks anything paid).
    if (newStatus === 'completed' && order.payment_status !== 'PAID') {
        return { error: 'payment_pending' };
    }

    // Guarded update: applies only if the order is still in the status we read, so a
    // repeated / concurrent click can't apply the same transition twice.
    const [, info] = await pool.execute(
        `UPDATE orders SET status = ?, rejection_reason = ?
         WHERE id = ? AND status = ?${newStatus === 'completed' ? " AND payment_status = 'PAID'" : ''}`,
        [newStatus, newStatus === 'rejected' ? (rejectionReason || null) : order.rejection_reason, orderId, order.status]
    );
    if (!info || info.rowCount === 0) {
        const current = await getOrderById(orderId, shopId);
        return { error: 'invalid_transition', from: current?.status || order.status, to: newStatus };
    }
    return { order: await getOrderById(orderId, shopId) };
}

/**
 * Super Admin financial summary over PAID orders, split into the printer's printing
 * charges and Campus Print's extra charges, overall and per collection location.
 * Orders placed before charges were itemised are counted separately (their totals
 * are never re-split here). Refunds are reported separately, not netted silently.
 */
async function getFinancialSummary({ dateFrom = '', dateTo = '', location = '' } = {}) {
    const where = ["o.payment_status = 'PAID'"];
    const params = [];
    if (dateFrom) { where.push('o.created_at >= ?'); params.push(dateFrom); }
    if (dateTo) { where.push('o.created_at <= ?'); params.push(`${dateTo} 23:59:59`); }
    if (location) { where.push('o.collection_location_id = ?'); params.push(location); }
    const whereClause = `WHERE ${where.join(' AND ')}`;

    const columns = `
        COUNT(*) AS paid_orders,
        COUNT(o.printing_amount) AS itemised_orders,
        COALESCE(SUM(o.total_price) FILTER (WHERE o.printing_amount IS NOT NULL), 0) AS itemised_customer_total,
        COALESCE(SUM(o.printing_amount), 0) AS printing,
        COALESCE(SUM(o.service_charge), 0) AS service,
        COALESCE(SUM(o.delivery_charge), 0) AS delivery,
        COALESCE(SUM(o.classroom_charge), 0) AS classroom,
        COUNT(*) FILTER (WHERE o.printing_amount IS NULL) AS not_itemised_orders,
        COALESCE(SUM(o.total_price) FILTER (WHERE o.printing_amount IS NULL), 0) AS not_itemised_total`;

    const [[totalsRow]] = await pool.query(`SELECT ${columns} FROM orders o ${whereClause}`, params);
    const [locationRows] = await pool.query(
        `SELECT o.collection_location_id, MAX(o.collection_location) AS collection_location, ${columns}
         FROM orders o ${whereClause}
         GROUP BY o.collection_location_id ORDER BY o.collection_location_id`,
        params
    );
    const [[refundRow]] = await pool.query(
        `SELECT COALESCE(SUM(p.amount), 0) AS refunded, COUNT(*) AS refunded_payments
         FROM payments p JOIN orders o ON o.id = p.order_id
         ${whereClause} AND p.status = 'refunded'`,
        params
    );

    const shape = (r) => {
        const num = (v) => Math.round(parseFloat(v || 0) * 100) / 100;
        const printing = num(r.printing);
        const extras = num(num(r.service) + num(r.delivery) + num(r.classroom));
        const itemisedCustomerTotal = num(r.itemised_customer_total);
        return {
            paidOrders: parseInt(r.paid_orders, 10),
            itemisedOrders: parseInt(r.itemised_orders, 10),
            totalPrinting: printing,
            printerPayable: printing,
            totalService: num(r.service),
            totalDelivery: num(r.delivery),
            totalClassroom: num(r.classroom),
            otherCharges: 0,
            // Gross, not profit: gateway fees, taxes and other costs are not deducted.
            grossExtraRevenue: extras,
            itemisedCustomerTotal,
            reconciled: Math.abs(itemisedCustomerTotal - (printing + extras)) < 0.01,
            notItemisedOrders: parseInt(r.not_itemised_orders, 10),
            notItemisedCustomerTotal: num(r.not_itemised_total),
            customerTotal: num(itemisedCustomerTotal + num(r.not_itemised_total))
        };
    };

    return {
        filters: { dateFrom: dateFrom || null, dateTo: dateTo || null, location: location || null },
        totals: shape(totalsRow),
        byLocation: locationRows.map(r => ({
            locationId: r.collection_location_id,
            location: r.collection_location,
            ...shape(r)
        })),
        refunds: {
            refundedAmount: Math.round(parseFloat(refundRow.refunded || 0) * 100) / 100,
            refundedPayments: parseInt(refundRow.refunded_payments, 10)
        },
        // Not recorded anywhere in the system today.
        notTracked: ['taxes', 'discounts', 'gatewayFees']
    };
}

// Which amount the money aggregates sum: the customer's total (Super Admin) or only
// the printer's printing charges (Printer Admin). Whitelisted — never user input.
const AMOUNT_COLUMNS = { customer: 'total_price', printing: 'printing_amount' };

function amountColumn(view) {
    return AMOUNT_COLUMNS[view] || AMOUNT_COLUMNS.customer;
}

async function getDashboardStats(shopId = null, { view = 'customer' } = {}) {
    const col = amountColumn(view);
    const shopFilter = shopId ? ' AND shop_id = ?' : '';
    const shopParams = shopId ? [shopId] : [];

    const [statusRows] = await pool.query(
        `SELECT status, COUNT(*) AS count FROM orders WHERE payment_status = 'PAID' ${shopFilter} GROUP BY status`,
        shopParams
    );
    const counts = { pending: 0, accepted: 0, printing: 0, ready: 0, completed: 0, rejected: 0, cancelled: 0 };
    statusRows.forEach(r => { counts[r.status] = parseInt(r.count, 10); });

    const [[todayRow]] = await pool.query(
        `SELECT COUNT(*) AS orders_today, COALESCE(SUM(${col}), 0) AS earnings_today
         FROM orders WHERE payment_status = 'PAID' AND DATE(created_at) = CURDATE()
           AND status NOT IN ('rejected','cancelled') ${shopFilter}`,
        shopParams
    );
    const [[totalRow]] = await pool.query(
        `SELECT COALESCE(SUM(${col}), 0) AS total_earnings,
                COUNT(*) FILTER (WHERE ${col} IS NULL) AS not_itemised
         FROM orders
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
        // Completed orders with no saved amount of this kind (placed before itemising).
        notItemisedCount: parseInt(totalRow.not_itemised, 10),
        recentOrders
    };
}

async function getEarnings(shopId = null, { view = 'customer' } = {}) {
    const col = amountColumn(view);
    const shopFilter = shopId ? 'AND shop_id = ?' : '';
    const shopParams = shopId ? [shopId] : [];
    // Counts only orders that have this amount, so averages aren't skewed by
    // orders placed before charges were itemised.
    const sumCount = `COALESCE(SUM(${col}), 0) AS amount, COUNT(${col}) AS count`;

    const [[today]] = await pool.query(
        `SELECT ${sumCount} FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed' AND DATE(created_at) = CURDATE() ${shopFilter}`, shopParams
    );
    const [[yesterday]] = await pool.query(
        `SELECT ${sumCount} FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed' AND DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY) ${shopFilter}`, shopParams
    );
    const [[week]] = await pool.query(
        `SELECT ${sumCount} FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed' AND YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1) ${shopFilter}`, shopParams
    );
    const [[month]] = await pool.query(
        `SELECT ${sumCount} FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed' AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE()) ${shopFilter}`, shopParams
    );
    const [[total]] = await pool.query(
        `SELECT ${sumCount}, COUNT(*) FILTER (WHERE ${col} IS NULL) AS not_itemised FROM orders
         WHERE payment_status = 'PAID' AND status = 'completed' ${shopFilter}`, shopParams
    );
    const [trend] = await pool.query(
        `SELECT DATE(created_at) AS date, COALESCE(SUM(${col}), 0) AS amount
         FROM orders WHERE payment_status = 'PAID' AND status = 'completed'
           AND created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) ${shopFilter}
         GROUP BY DATE(created_at) ORDER BY date ASC`, shopParams
    );
    const txFilter = shopId ? 'AND o.shop_id = ?' : '';
    const [recentTransactions] = await pool.query(
        `SELECT o.id, o.${col} AS amount, o.created_at, u.email AS customer_email
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
        notItemisedCount: parseInt(total.not_itemised, 10),
        avgOrderValue,
        trend: trend.map(r => ({ date: r.date, amount: parseFloat(r.amount) })),
        recentTransactions: recentTransactions.map(t => ({
            ...t,
            amount: t.amount === null ? null : parseFloat(t.amount),
            // Kept for existing Super Admin screens that read total_price.
            ...(col === 'total_price' ? { total_price: t.amount } : {})
        }))
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
    getFinancialSummary,
    getEarnings,
    getPlatformStats
};
