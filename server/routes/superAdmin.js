const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Order = require('../models/Order');
const OrderFile = require('../models/OrderFile');
const Shop = require('../models/Shop');
const Payment = require('../models/Payment');
const { requireSuperAdmin } = require('../middleware/roleAuth');
const { sendStoredFile } = require('../sendStoredFile');
const { financialBreakdown } = require('../services/orderFinance');
const { processSuccessfulPayment } = require('../services/paymentFinalizer');
const cashfree = require('../cashfree');
const { reconcileCashfreePayment } = require('./orders');

// ── Auth ──────────────────────────────────────────

// @route  POST /api/super-admin/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password)
            return res.status(400).json({ message: 'Please provide email and password' });

        const user = await User.findByEmail(email);
        if (user && user.role === 'super_admin' && user.is_active && (await User.matchPassword(password, user.password))) {
            // 1. Session Fixation Protection: Regenerate session ID
            req.session.regenerate(async (err) => {
                if (err) {
                    console.error('Session regeneration error:', err);
                    return res.status(500).json({ message: 'Internal server error' });
                }

                // 2. Concurrency Limit: Max 2 active sessions
                try {
                    const [activeSessions] = await require('../db').query(
                        'SELECT 1 FROM admin_sessions WHERE user_id = ? AND revocation_status = false',
                        [user.id]
                    );
                    if (activeSessions.length >= 2) {
                        return res.status(403).json({ message: 'Too many active sessions. Please logout from other devices.' });
                    }

                    // 3. Register session
                    await require('../db').query(
                        'INSERT INTO admin_sessions (sid, user_id, role) VALUES (?, ?, ?)',
                        [req.sessionID, user.id, 'super_admin']
                    );

                    req.session.superAdminId = user.id;
                    req.session.superAdminEmail = user.email;
                    req.session.superAdminRole = 'super_admin';
                    res.status(200).json({ id: user.id, email: user.email, message: 'Login successful' });
                } catch (dbErr) {
                    console.error('Super admin session registration error:', dbErr);
                    res.status(500).json({ message: 'Internal server error' });
                }
            });
        } else {
            res.status(401).json({ message: 'Invalid email or password' });
        }
    } catch (error) {
        console.error('Super admin login error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route  GET /api/super-admin/status
router.get('/status', (req, res) => {
    if (req.session && req.session.superAdminId && req.session.superAdminRole === 'super_admin') {
        res.status(200).json({ isLoggedIn: true, email: req.session.superAdminEmail || '' });
    } else {
        res.status(200).json({ isLoggedIn: false });
    }
});

// @route  POST /api/super-admin/logout
router.post('/logout', async (req, res) => {
    const sid = req.sessionID;
    try {
        // Mark session as revoked in registry
        await require('../db').query(
            'UPDATE admin_sessions SET revocation_status = true WHERE sid = ?',
            [sid]
        );
        req.session.destroy(err => {
            if (err) return res.status(500).json({ message: 'Error logging out' });
            res.clearCookie('connect.sid');
            res.status(200).json({ message: 'Logged out successfully' });
        });
    } catch (err) {
        console.error('Super admin logout registry error:', err);
        // Proceed with session destroy anyway
        req.session.destroy(() => res.status(200).json({ message: 'Logged out successfully' }));
    }
});

// ── Dashboard ─────────────────────────────────────

router.get('/dashboard', requireSuperAdmin, async (req, res) => {
    try {
        const [orderStats, userStats, shopStats, paymentStats, recent] = await Promise.all([
            Order.getPlatformStats(),
            User.getPlatformUserStats(),
            Shop.getPlatformShopStats(),
            Payment.getPlatformPaymentStats(),
            Order.listOrders({ limit: 5 })
        ]);
        res.json({ orderStats, userStats, shopStats, paymentStats, recentOrders: recent.orders });
    } catch (err) {
        console.error('Super admin dashboard error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ── User / Student Management ────────────────────

router.get('/users', requireSuperAdmin, async (req, res) => {
    try {
        const { search = '', role = '', page = 1, limit = 20 } = req.query;
        const result = await User.listUsers({ search, role, page: Number(page), limit: Number(limit) });
        res.json(result);
    } catch (err) {
        console.error('Super admin list users error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.get('/users/:id', requireSuperAdmin, async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ message: 'User not found' });
        const orders = await Order.getOrdersByUser(user.id);
        res.json({ ...user, orders });
    } catch (err) {
        console.error('Super admin get user error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.patch('/users/:id/active', requireSuperAdmin, async (req, res) => {
    try {
        const { isActive } = req.body;
        const user = await User.setActive(req.params.id, !!isActive);
        res.json(user);
    } catch (err) {
        console.error('Super admin set active error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ── Shop Management ───────────────────────────────

router.get('/shops', requireSuperAdmin, async (req, res) => {
    try {
        const { search = '', status = '', page = 1, limit = 20 } = req.query;
        const result = await Shop.listShops({ search, status, page: Number(page), limit: Number(limit) });
        res.json(result);
    } catch (err) {
        console.error('Super admin list shops error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.get('/shops/:id', requireSuperAdmin, async (req, res) => {
    try {
        const shop = await Shop.getShopById(req.params.id);
        if (!shop) return res.status(404).json({ message: 'Shop not found' });
        const orders = await Order.listOrders({ shopId: shop.id, limit: 10 });
        res.json({ ...shop, recentOrders: orders.orders });
    } catch (err) {
        console.error('Super admin get shop error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.put('/shops/:id', requireSuperAdmin, async (req, res) => {
    try {
        const shop = await Shop.updateShop(req.params.id, req.body);
        res.json(shop);
    } catch (err) {
        console.error('Super admin update shop error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.patch('/shops/:id/approval', requireSuperAdmin, async (req, res) => {
    try {
        const { status } = req.body;
        if (!['pending', 'approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid approval status' });
        }
        const shop = await Shop.setApprovalStatus(req.params.id, status);
        res.json(shop);
    } catch (err) {
        console.error('Super admin shop approval error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.patch('/shops/:id/active', requireSuperAdmin, async (req, res) => {
    try {
        const { isActive } = req.body;
        const shop = await Shop.setActive(req.params.id, !!isActive);
        res.json(shop);
    } catch (err) {
        console.error('Super admin shop active error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ── Global Order Management ───────────────────────

router.get('/orders', requireSuperAdmin, async (req, res) => {
    try {
        const { search = '', status = '', dateFrom = '', dateTo = '', page = 1, limit = 20, sort = 'created_at', dir = 'DESC' } = req.query;
        const result = await Order.listOrders({ search, status, dateFrom, dateTo, page: Number(page), limit: Number(limit), sort, dir });
        // Per-row split for the list (no files needed for the totals).
        const orders = result.orders.map(o => {
            const finance = financialBreakdown(o);
            return {
                ...o,
                finance: {
                    basis: finance.basis,
                    printerPayable: finance.summary.printerPayable,
                    grossExtraRevenue: finance.summary.grossExtraRevenue,
                    customerTotal: finance.summary.customerTotal
                }
            };
        });
        res.json({ ...result, orders });
    } catch (err) {
        console.error('Super admin list orders error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.get('/orders/:id', requireSuperAdmin, async (req, res) => {
    try {
        const order = await Order.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found' });
        const [files, payments] = await Promise.all([
            OrderFile.getFilesByOrder(order.id),
            Payment.listForOrder(order.id)
        ]);
        const view = { ...order };
        delete view.ticket_access_token_hash;
        res.json({
            ...view,
            files,
            payments,
            payment: payments.length ? payments[payments.length - 1] : null,
            finance: financialBreakdown(order, files, payments)
        });
    } catch (err) {
        console.error('Super admin get order error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

const PAYMENT_PENDING_MESSAGE = 'Payment for this order is not confirmed yet, so it cannot be accepted.';

// Accept = the order is printed and moves straight to Completed (Ready for Pickup).
router.post('/orders/:id/accept', requireSuperAdmin, async (req, res) => {
    try {
        const result = await Order.updateStatus(req.params.id, 'completed');
        if (result.error === 'not_found') return res.status(404).json({ message: 'Order not found' });
        if (result.error === 'payment_pending') return res.status(409).json({ message: PAYMENT_PENDING_MESSAGE });
        if (result.error) return res.status(409).json({ message: 'This order was already handled.', status: result.from });
        res.json(result.order);
    } catch (err) {
        console.error('Super admin accept order error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.post('/orders/:id/reject', requireSuperAdmin, async (req, res) => {
    try {
        const { reason } = req.body || {};
        const result = await Order.updateStatus(req.params.id, 'rejected', reason);
        if (result.error === 'not_found') return res.status(404).json({ message: 'Order not found' });
        if (result.error) return res.status(409).json({ message: 'This order was already handled.', status: result.from });
        await Payment.refundForOrder(req.params.id);
        res.json(result.order);
    } catch (err) {
        console.error('Super admin reject order error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// Owner confirms a UPI QR / manual payment was received (they can see the customer
// total to check the transfer). Goes through the same finalizer as Cashfree.
router.post('/orders/:id/mark-paid', requireSuperAdmin, async (req, res) => {
    try {
        const order = await Order.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found' });
        const pending = await Order.getAdminConfirmablePayment(order.id);
        if (!pending) return res.status(400).json({ message: 'This order has no pending payment to confirm.' });
        const result = await processSuccessfulPayment(order.id, {
            paymentId: pending.id,
            method: pending.method,
            amount: pending.amount,
            currency: pending.currency,
            source: 'super_admin_mark_paid'
        });
        const payment = await Payment.findByOrderId(order.id);
        res.json({
            status: payment.status,
            method: payment.method,
            transaction_ref: payment.transaction_ref,
            payment_status: 'PAID',
            ticket_status: result.ticketStatus,
            ticket_number: result.ticketNumber
        });
    } catch (err) {
        if (err.code === 'PAYMENT_AMOUNT_MISMATCH') {
            return res.status(409).json({ message: 'Payment amount does not match the order. Not marked paid.' });
        }
        console.error('Super admin mark paid error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ── Financials: printer payable vs Campus Print extras, across orders ──
// ?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD&location=<collection_location_id>
router.get('/financials', requireSuperAdmin, async (req, res) => {
    try {
        const { dateFrom = '', dateTo = '', location = '' } = req.query;
        res.json(await Order.getFinancialSummary({ dateFrom, dateTo, location }));
    } catch (err) {
        console.error('Super admin financials error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.get('/orders/:orderId/documents/:fileId', requireSuperAdmin, async (req, res) => {
    try {
        const file = await OrderFile.getFileById(req.params.fileId);
        if (!file || String(file.order_id) !== String(req.params.orderId)) {
            return res.status(404).json({ message: 'File not found' });
        }
        await sendStoredFile(res, file, { download: req.query.download === '1' || req.query.download === 'true' });
    } catch (err) {
        console.error('Super admin document access error:', err.message);
        res.status(500).json({ message: 'Could not load this file right now. Please retry.', code: 'FILE_LOAD_FAILED' });
    }
});

// ── Payments ───────────────────────────────────────

router.get('/payments', requireSuperAdmin, async (req, res) => {
    try {
        const stats = await Payment.getPlatformPaymentStats();
        res.json(stats);
    } catch (err) {
        console.error('Super admin payments stats error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.get('/transactions', requireSuperAdmin, async (req, res) => {
    try {
        const { search = '', status = '', dateFrom = '', dateTo = '', page = 1, limit = 20 } = req.query;
        const result = await Payment.listPayments({ search, status, dateFrom, dateTo, page: Number(page), limit: Number(limit) });
        res.json(result);
    } catch (err) {
        console.error('Super admin transactions error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// Read-only gateway status — secrets stay on the server.
// Kept as a clean abstraction: secrets are never sent to the frontend,
// and this reflects real configuration state rather than fabricated data.
router.get('/payment-gateway', requireSuperAdmin, async (req, res) => {
    const cashfree = require('../cashfree');
    const configured = cashfree.isConfigured();
    res.json({
        provider: 'Cashfree',
        configured,
        mode: configured ? cashfree.getMode() : null,
        webhookConfigured: !!process.env.PUBLIC_API_URL,
        status: configured ? 'connected' : 'not_connected'
    });
});

// ── Analytics ─────────────────────────────────────

router.get('/analytics', requireSuperAdmin, async (req, res) => {
    try {
        const [orderStats, earnings] = await Promise.all([
            Order.getPlatformStats(),
            Order.getEarnings()
        ]);
        res.json({ orderStats, earnings });
    } catch (err) {
        console.error('Super admin analytics error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ── Account Settings ───────────────────────────────

router.put('/account/password', requireSuperAdmin, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Current and new password are required' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ message: 'New password must be at least 8 characters' });
        }
        const user = await User.findByEmail(req.session.superAdminEmail);
        if (!user || !(await User.matchPassword(currentPassword, user.password))) {
            return res.status(401).json({ message: 'Current password is incorrect' });
        }
        await User.updatePassword(user.id, newPassword);
        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error('Super admin change password error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// POST /api/super-admin/orders/:id/reconcile-cashfree
// Re-verifies a pending Cashfree order against the Cashfree API and finalizes if
// confirmed paid. Use ?dry_run=true to inspect without changing anything.
router.post('/orders/:id/reconcile-cashfree', requireSuperAdmin, async (req, res) => {
    try {
        const order = await Order.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found' });

        if (order.payment_method !== 'CASHFREE') {
            return res.status(400).json({ message: 'This order does not use Cashfree payment.' });
        }

        const attempt = await Order.getLatestCashfreeAttempt(order.id);
        if (!attempt) {
            return res.status(400).json({ message: 'No Cashfree payment attempt found for this order.' });
        }

        const dryRun = req.query.dry_run === 'true' || req.query.dry_run === '1';

        if (dryRun) {
            if (!cashfree.isConfigured()) {
                return res.status(503).json({ message: 'Cashfree is not configured on this server.' });
            }
            const providerOrder = await cashfree.fetchOrder(attempt.gateway_order_id);
            const providerPayments = await cashfree.fetchOrderPayments(attempt.gateway_order_id);
            const successPayment = providerPayments.find(p => cashfree.isPaymentPaid(p));

            return res.json({
                dryRun: true,
                orderId: order.id,
                cashfreeOrderId: attempt.gateway_order_id,
                orderAmount: Number(order.total_price),
                currentPaymentStatus: order.payment_status,
                currentTicketStatus: order.ticket_status,
                cashfreeOrderStatus: providerOrder.order_status,
                cashfreeOrderAmount: providerOrder.order_amount,
                cashfreePaymentCount: providerPayments.length,
                successfulPayment: successPayment ? {
                    cfPaymentId: successPayment.cf_payment_id,
                    status: successPayment.payment_status,
                    amount: successPayment.payment_amount,
                    currency: successPayment.payment_currency,
                } : null,
                wouldFinalize: cashfree.isOrderPaid(providerOrder) && !!successPayment,
                amountMatch: cashfree.amountsMatch(providerOrder.order_amount, order.total_price),
            });
        }

        const result = await reconcileCashfreePayment(attempt.gateway_order_id, 'super_admin_reconcile');

        console.info('[SUPER_ADMIN_RECONCILE]', {
            orderId: order.id,
            cashfreeOrderId: attempt.gateway_order_id,
            result: result.status,
            ticketNumber: result.ticketNumber || null
        });

        res.json({
            dryRun: false,
            orderId: order.id,
            cashfreeOrderId: attempt.gateway_order_id,
            ...result
        });
    } catch (err) {
        console.error('Super admin reconcile error:', err);
        res.status(err.code === 'PAYMENT_ORDER_MISMATCH' ? 409 : 500).json({
            message: err.message || 'Reconciliation failed.',
            code: err.code || 'RECONCILE_FAILED'
        });
    }
});

module.exports = router;
