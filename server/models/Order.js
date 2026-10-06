const pool = require('../db');
const Profile = require('./Profile');

async function createOrder(userId, shopId, data) {
    const {
        paperSize, copies, spiralBinding, expressDelivery, totalPrice, fileCount,
        collectionLocationId, collectionLocationName, collectionTime, collectionDate, totalPages,
        guestFullName, guestPhone, guestClassroom
    } = data;

    let studentId = null;
    if (userId) {
        const profile = await Profile.getProfileByUserId(userId);
        studentId = profile ? profile.id : null;
    }

    const [result] = await pool.execute(
        `INSERT INTO orders
            (user_id, student_id, shop_id, paper_size, copies, spiral_binding, express_delivery, total_price, file_count,
             collection_location_id, collection_location, collection_time, collection_date, total_pages,
             guest_full_name, guest_phone, guest_classroom)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            collectionDate || null,
            totalPages || 0,
            guestFullName || null,
            guestPhone || null,
            guestClassroom || null
        ]
    );
    const ticketNumber = `CP-${String(result.insertId).padStart(3, '0')}`;
    await pool.execute(`UPDATE orders SET ticket_number = ? WHERE id = ?`, [ticketNumber, result.insertId]);
    return { id: result.insertId, ticketNumber };
}

async function getOrderForUser(orderId, userId) {
    const [rows] = await pool.execute(
        `SELECT o.*, u.email AS customer_email, p.full_name, p.phone_number, p.class_room_number
         FROM orders o
         JOIN users u ON u.id = o.user_id
         LEFT JOIN student_profiles p ON p.id = o.student_id
         WHERE o.id = ? AND o.user_id = ?`,
        [orderId, userId]
    );
    return rows[0] || null;
}

async function getOrdersByUser(userId) {
    const [rows] = await pool.execute(
        `SELECT o.*, p.full_name, p.phone_number, p.class_room_number
         FROM orders o
         LEFT JOIN student_profiles p ON p.id = o.student_id
         WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 50`,
        [userId]
    );
    return rows;
}

async function getOrderStats(userId) {
    const [rows] = await pool.execute(
        'SELECT status, COUNT(*) AS count FROM orders WHERE user_id = ? GROUP BY status',
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
    const where = [];
    const params = [];

    if (shopId) {
        where.push('o.shop_id = ?');
        params.push(shopId);
    }
    if (search) {
        where.push('(o.id = ? OR u.email LIKE ? OR p.full_name LIKE ?)');
        params.push(Number(search) || 0, `%${search}%`, `%${search}%`);
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
        `SELECT COUNT(*) AS count FROM orders o LEFT JOIN users u ON u.id = o.user_id ${whereClause}`,
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
         WHERE o.id = ? ${shopFilter}`,
        params
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
    const shopFilter = shopId ? 'WHERE shop_id = ?' : '';
    const shopParams = shopId ? [shopId] : [];

    const [statusRows] = await pool.query(`SELECT status, COUNT(*) AS count FROM orders ${shopFilter} GROUP BY status`, shopParams);
    const counts = { pending: 0, accepted: 0, printing: 0, ready: 0, completed: 0, rejected: 0, cancelled: 0 };
    statusRows.forEach(r => { counts[r.status] = parseInt(r.count, 10); });

    const todayFilter = shopId ? 'AND shop_id = ?' : '';
    const [[todayRow]] = await pool.query(
        `SELECT COUNT(*) AS orders_today, COALESCE(SUM(total_price), 0) AS earnings_today
         FROM orders WHERE DATE(created_at) = CURDATE() AND status NOT IN ('rejected','cancelled') ${todayFilter}`,
        shopParams
    );
    const [[totalRow]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS total_earnings FROM orders WHERE status = 'completed' ${todayFilter}`,
        shopParams
    );
    const recentFilter = shopId ? 'WHERE o.shop_id = ?' : '';
    const [recentOrders] = await pool.query(
        `SELECT o.*, u.email AS customer_email FROM orders o LEFT JOIN users u ON u.id = o.user_id
         ${recentFilter} ORDER BY o.created_at DESC LIMIT 5`,
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
         WHERE status = 'completed' AND DATE(created_at) = CURDATE() ${shopFilter}`, shopParams
    );
    const [[yesterday]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS amount, COUNT(*) AS count FROM orders
         WHERE status = 'completed' AND DATE(created_at) = DATE_SUB(CURDATE(), INTERVAL 1 DAY) ${shopFilter}`, shopParams
    );
    const [[week]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS amount, COUNT(*) AS count FROM orders
         WHERE status = 'completed' AND YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1) ${shopFilter}`, shopParams
    );
    const [[month]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS amount, COUNT(*) AS count FROM orders
         WHERE status = 'completed' AND YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE()) ${shopFilter}`, shopParams
    );
    const [[total]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS amount, COUNT(*) AS count FROM orders WHERE status = 'completed' ${shopFilter}`, shopParams
    );
    const [trend] = await pool.query(
        `SELECT DATE(created_at) AS date, COALESCE(SUM(total_price), 0) AS amount
         FROM orders WHERE status = 'completed' AND created_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY) ${shopFilter}
         GROUP BY DATE(created_at) ORDER BY date ASC`, shopParams
    );
    const txFilter = shopId ? 'AND o.shop_id = ?' : '';
    const [recentTransactions] = await pool.query(
        `SELECT o.id, o.total_price, o.created_at, u.email AS customer_email
         FROM orders o LEFT JOIN users u ON u.id = o.user_id
         WHERE o.status = 'completed' ${txFilter} ORDER BY o.created_at DESC LIMIT 10`, shopParams
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
    const [statusRows] = await pool.query('SELECT status, COUNT(*) AS count FROM orders GROUP BY status');
    const counts = { pending: 0, accepted: 0, printing: 0, ready: 0, completed: 0, rejected: 0, cancelled: 0 };
    statusRows.forEach(r => { counts[r.status] = parseInt(r.count, 10); });

    const [[revenueRow]] = await pool.query(
        `SELECT COALESCE(SUM(total_price), 0) AS revenue FROM orders WHERE status = 'completed'`
    );
    const [ordersOverTime] = await pool.query(
        `SELECT DATE(created_at) AS date, COUNT(*) AS count
         FROM orders WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
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
    createOrder,
    getOrderForUser,
    getOrdersByUser,
    getOrderStats,
    VALID_STATUSES,
    ALLOWED_TRANSITIONS,
    listOrders,
    getOrderById,
    updateStatus,
    getDashboardStats,
    getEarnings,
    getPlatformStats
};
