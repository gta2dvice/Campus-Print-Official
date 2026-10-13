const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();
const User = require('../models/User');
const Order = require('../models/Order');
const OrderFile = require('../models/OrderFile');
const Shop = require('../models/Shop');
const Payment = require('../models/Payment');
const { requireShopAdmin } = require('../middleware/roleAuth');
const { toPrinterOrder } = require('../services/orderFinance');
const { sendStoredFile } = require('../sendStoredFile');
const { uploadBuffer, deleteFiles, downloadFile } = require('../storage');

const QR_MIME_EXTENSIONS = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const qrUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => cb(null, Object.prototype.hasOwnProperty.call(QR_MIME_EXTENSIONS, file.mimetype))
});

// ── Auth ──────────────────────────────────────────

// @route  POST /api/admin/login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password)
            return res.status(400).json({ message: 'Please provide email and password' });

        const user = await User.findByEmail(email);
        if (user && user.role === 'shop_admin' && user.is_active && (await User.matchPassword(password, user.password))) {
            req.session.adminId = user.id;
            req.session.adminEmail = user.email;
            req.session.adminRole = 'shop_admin';
            req.session.adminShopId = user.shop_id;
            res.status(200).json({ id: user.id, email: user.email, message: 'Login successful' });
        } else {
            res.status(401).json({ message: 'Invalid email or password' });
        }
    } catch (error) {
        console.error('Admin login error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

// @route  GET /api/admin/status
router.get('/status', (req, res) => {
    if (req.session && req.session.adminId && req.session.adminRole === 'shop_admin') {
        res.status(200).json({ isLoggedIn: true, email: req.session.adminEmail || '' });
    } else {
        res.status(200).json({ isLoggedIn: false });
    }
});

// @route  POST /api/admin/logout
router.post('/logout', (req, res) => {
    req.session.adminId = null;
    req.session.adminEmail = null;
    req.session.adminRole = null;
    req.session.adminShopId = null;
    res.status(200).json({ message: 'Logged out successfully' });
});

// The Printer Admin (shop_admin) sees printing charges only. Every response below
// that carries an order or an amount goes through services/orderFinance, which
// whitelists order fields and replaces the customer total with the printer's
// printing amount. Campus Print's extra charges never leave the server here.

const PAYMENT_PENDING_MESSAGE = 'Payment for this order is not confirmed yet, so it cannot be accepted.';

// ── Dashboard ─────────────────────────────────────

router.get('/dashboard', requireShopAdmin, async (req, res) => {
    try {
        const stats = await Order.getDashboardStats(req.shopId, { view: 'printing' });
        stats.recentOrders = stats.recentOrders.map(o => toPrinterOrder(o));
        res.json(stats);
    } catch (err) {
        console.error('Admin dashboard error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ── Orders ────────────────────────────────────────

router.get('/orders', requireShopAdmin, async (req, res) => {
    try {
        const { search = '', status = '', dateFrom = '', dateTo = '', page = 1, limit = 20, sort = 'created_at', dir = 'DESC' } = req.query;
        const result = await Order.listOrders({ search, status, dateFrom, dateTo, page: Number(page), limit: Number(limit), sort, dir, shopId: req.shopId, view: 'printing' });
        res.json({ ...result, orders: result.orders.map(o => toPrinterOrder(o)) });
    } catch (err) {
        console.error('Admin list orders error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.get('/orders/:id', requireShopAdmin, async (req, res) => {
    try {
        const order = await Order.getOrderById(req.params.id, req.shopId);
        if (!order) return res.status(404).json({ message: 'Order not found' });
        const files = await OrderFile.getFilesByOrder(order.id);
        const payment = await Payment.findByOrderId(order.id);
        res.json({
            ...toPrinterOrder(order, files),
            payment: payment ? { status: payment.status, method: payment.method, transaction_ref: payment.transaction_ref } : null
        });
    } catch (err) {
        console.error('Admin get order error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.patch('/orders/:id/status', requireShopAdmin, async (req, res) => {
    try {
        const { status, reason } = req.body;
        if (!Order.VALID_STATUSES.includes(status)) {
            return res.status(400).json({ message: 'Invalid status value' });
        }
        const result = await Order.updateStatus(req.params.id, status, reason, req.shopId);
        if (result.error === 'not_found') return res.status(404).json({ message: 'Order not found' });
        if (result.error === 'payment_pending') return res.status(409).json({ message: PAYMENT_PENDING_MESSAGE });
        if (result.error === 'invalid_transition') {
            return res.status(409).json({ message: `Cannot move order from ${result.from} to ${result.to}`, status: result.from });
        }
        if (status === 'rejected' || status === 'cancelled') {
            await Payment.refundForOrder(req.params.id);
        }
        res.json(toPrinterOrder(result.order));
    } catch (err) {
        console.error('Admin update status error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// Accept = the order is printed and moves straight to Completed (Ready for Pickup).
router.post('/orders/:id/accept', requireShopAdmin, async (req, res) => {
    try {
        const result = await Order.updateStatus(req.params.id, 'completed', null, req.shopId);
        if (result.error === 'not_found') return res.status(404).json({ message: 'Order not found' });
        if (result.error === 'payment_pending') return res.status(409).json({ message: PAYMENT_PENDING_MESSAGE });
        if (result.error) return res.status(409).json({ message: 'This order was already handled.', status: result.from });
        res.json(toPrinterOrder(result.order));
    } catch (err) {
        console.error('Admin accept order error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.post('/orders/:id/reject', requireShopAdmin, async (req, res) => {
    try {
        const { reason } = req.body;
        const result = await Order.updateStatus(req.params.id, 'rejected', reason, req.shopId);
        if (result.error === 'not_found') return res.status(404).json({ message: 'Order not found' });
        if (result.error) return res.status(409).json({ message: 'This order was already handled.', status: result.from });
        await Payment.refundForOrder(req.params.id);
        res.json(toPrinterOrder(result.order));
    } catch (err) {
        console.error('Admin reject order error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// Confirming UPI QR / manual payments needs the customer total, so it is a Super
// Admin action (POST /api/super-admin/orders/:id/mark-paid). There is deliberately
// no shop-admin mark-paid route.

// Secure document access — only a logged-in shop admin can view/download
router.get('/orders/:orderId/documents/:fileId', requireShopAdmin, async (req, res) => {
    try {
        const order = await Order.getOrderById(req.params.orderId, req.shopId);
        if (!order) return res.status(404).json({ message: 'Order not found' });

        const file = await OrderFile.getFileById(req.params.fileId);
        if (!file || String(file.order_id) !== String(req.params.orderId)) {
            return res.status(404).json({ message: 'File not found' });
        }
        await sendStoredFile(res, file, { download: req.query.download === '1' || req.query.download === 'true' });
    } catch (err) {
        console.error('Admin document access error:', err.message);
        res.status(500).json({ message: 'Could not load this file right now. Please retry.', code: 'FILE_LOAD_FAILED' });
    }
});

// ── Earnings ──────────────────────────────────────

router.get('/earnings', requireShopAdmin, async (req, res) => {
    try {
        const earnings = await Order.getEarnings(req.shopId, { view: 'printing' });
        res.json(earnings);
    } catch (err) {
        console.error('Admin earnings error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ── Transactions: printer payable per paid order (never the customer's payment) ──

router.get('/transactions', requireShopAdmin, async (req, res) => {
    try {
        const { search = '', status = '', dateFrom = '', dateTo = '', page = 1, limit = 20 } = req.query;
        const result = await Payment.listPrinterPayables({ search, status, dateFrom, dateTo, page: Number(page), limit: Number(limit), shopId: req.shopId });
        res.json(result);
    } catch (err) {
        console.error('Admin transactions error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ── Shop Profile ──────────────────────────────────

router.get('/shop-profile', requireShopAdmin, async (req, res) => {
    try {
        const profile = await Shop.getShopById(req.shopId);
        res.json(profile);
    } catch (err) {
        console.error('Admin get shop profile error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

router.put('/shop-profile', requireShopAdmin, async (req, res) => {
    try {
        const profile = await Shop.updateShop(req.shopId, req.body);
        res.json(profile);
    } catch (err) {
        console.error('Admin update shop profile error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// Preview of this shop's current payment QR for the Shop Profile page.
router.get('/shop-profile/payment-qr', requireShopAdmin, async (req, res) => {
    try {
        const shop = await Shop.getShopById(req.shopId);
        if (!shop?.payment_qr_path) return res.status(404).json({ message: 'No payment QR uploaded' });
        const buffer = await downloadFile(shop.payment_qr_path);
        res.setHeader('Content-Type', shop.payment_qr_mime || 'image/png');
        res.setHeader('Cache-Control', 'private, no-cache');
        res.send(buffer);
    } catch (err) {
        console.error('Admin payment QR preview error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// QR Payment image shown to students in the booking flow's payment step.
router.post('/shop-profile/payment-qr', requireShopAdmin, (req, res, next) => {
    qrUpload.single('qr')(req, res, (err) => {
        if (err) return res.status(400).json({ message: err.code === 'LIMIT_FILE_SIZE' ? 'QR image must be 5 MB or smaller.' : 'Could not read the uploaded image.' });
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'Upload a PNG, JPG or WEBP image.' });
        const previous = (await Shop.getShopById(req.shopId))?.payment_qr_path || null;
        const ext = QR_MIME_EXTENSIONS[req.file.mimetype];
        const storagePath = `shop-assets/shop-${req.shopId}/payment-qr-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
        await uploadBuffer({ storagePath, buffer: req.file.buffer, contentType: req.file.mimetype });
        const profile = await Shop.setPaymentQr(req.shopId, storagePath, req.file.mimetype);
        if (previous) {
            deleteFiles([previous]).catch((e) => console.error('Old payment QR cleanup failed:', e.message));
        }
        res.json(profile);
    } catch (err) {
        console.error('Admin payment QR upload error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ── Account Settings ───────────────────────────────

router.put('/account/password', requireShopAdmin, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Current and new password are required' });
        }
        if (newPassword.length < 8) {
            return res.status(400).json({ message: 'New password must be at least 8 characters' });
        }
        const user = await User.findByEmail(req.session.adminEmail);
        if (!user || !(await User.matchPassword(currentPassword, user.password))) {
            return res.status(401).json({ message: 'Current password is incorrect' });
        }
        await User.updatePassword(user.id, newPassword);
        res.json({ message: 'Password updated successfully' });
    } catch (err) {
        console.error('Admin change password error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

module.exports = router;
