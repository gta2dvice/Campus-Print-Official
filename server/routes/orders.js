const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const router = express.Router();
const Order = require('../models/Order');
const OrderFile = require('../models/OrderFile');
const Payment = require('../models/Payment');
const Shop = require('../models/Shop');
const { upload } = require('../middleware/upload');
const { detectPages } = require('../pageDetect');
const fileTypes = require('../fileTypes');
const upiQr = require('../upiQr');

// Pay via UPI QR: how long a generated QR stays valid before the user must refresh.
const UPI_QR_TTL_MS = 15 * 60 * 1000;
const slots = require('../slots');
const pool = require('../db');
const { uploadBuffer, buildObjectPath, deleteFiles, downloadFile } = require('../storage');
const cashfree = require('../cashfree');
const { requireProfile } = require('../middleware/roleAuth');
const { sendStoredFile } = require('../sendStoredFile');
const ticketToken = require('../ticketToken');
const RecoveryOtp = require('../models/RecoveryOtp');
const otpService = require('../services/otp');
const { normalizePhone, maskPhone } = require('../phone');
const { rateLimit } = require('../middleware/rateLimit');
const {
    establishRecoverySession,
    requireRecoverySession,
    isAuthorizedForOrder
} = require('../middleware/recoveryAuth');

// ── Rate limiters for recovery / ticket / document endpoints ────────────────
const WINDOW_15_MIN = 15 * 60 * 1000;
const lookupLimiter = rateLimit({ prefix: 'rec-lookup', windowMs: WINDOW_15_MIN, max: 5, key: (req) => normalizePhone(req.body?.phone) || '' });
const verifyLimiter = rateLimit({ prefix: 'rec-verify', windowMs: WINDOW_15_MIN, max: 10, key: (req) => normalizePhone(req.body?.phone) || '' });
const historyLimiter = rateLimit({ prefix: 'rec-history', windowMs: WINDOW_15_MIN, max: 60 });
const ticketLimiter = rateLimit({ prefix: 'rec-ticket', windowMs: WINDOW_15_MIN, max: 120 });
const documentLimiter = rateLimit({ prefix: 'rec-doc', windowMs: WINDOW_15_MIN, max: 120 });
// Higher cap: the UPI QR screen polls payment-status ~every 5s while waiting.
const pollLimiter = rateLimit({ prefix: 'poll-status', windowMs: WINDOW_15_MIN, max: 240 });

// Maps the internal payment row status to a UI-facing label.
function paymentStatusLabel(status) {
    switch (String(status || '').toLowerCase()) {
        case 'success': return 'PAID';
        case 'pending': return 'PENDING';
        case 'failed': return 'FAILED';
        case 'refunded': return 'REFUNDED';
        default: return 'PENDING';
    }
}

// Ticket is collectable once the shop has it ready/completed.
function ticketStatusLabel(orderStatus) {
    return ['ready', 'completed'].includes(String(orderStatus || '').toLowerCase()) ? 'READY' : 'GENERATING';
}

// Safe, recovery-facing view of an order. No credentials, no internal-only fields,
// no raw files. Includes a per-order ticket token so "View Ticket" works without
// re-verifying OTP. Phone is intentionally omitted here (masked where needed).
function toRecoveryOrderSummary(order) {
    const paymentStatus = paymentStatusLabel(order.payment_status);
    return {
        ticketId: order.ticket_number || `CP-${String(order.id).padStart(3, '0')}`,
        orderId: order.id,
        paymentStatus,
        orderStatus: String(order.status || '').toUpperCase(),
        ticketStatus: ticketStatusLabel(order.status),
        collectionLocation: order.collection_location || null,
        collectionTime: order.collection_time || null,
        collectionDate: order.collection_date || null,
        amount: Number(order.total_price) || 0,
        fileCount: order.file_count || 0,
        createdAt: order.created_at,
        // Only hand back a ticket token for orders that actually have a confirmed ticket.
        ticketToken: paymentStatus === 'PAID' ? ticketToken.sign(order.id) : null
    };
}

// In-memory upload just for page-count detection — nothing here touches disk.
const detectUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 10 }
});

function paymentGatewayReady() {
    return cashfree.isConfigured();
}

function paymentCreateErrorDetails(error) {
    const providerError = error?.response?.data;
    const errorBody = providerError && typeof providerError === 'object' ? providerError : {};
    const secrets = [
        process.env.CASHFREE_APP_ID,
        process.env.CASHFREE_SECRET_KEY
    ].filter(Boolean);
    let message = String(errorBody.message || errorBody.error_description || error?.message || 'Unknown payment error');
    for (const secret of secrets) {
        message = message.split(secret).join('[redacted]');
    }
    message = message
        .replace(/cfsk_[a-zA-Z0-9_-]+/g, '[redacted]')
        .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1[redacted]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
        .replace(/\b[6-9][0-9]{9}\b/g, '[redacted]')
        .slice(0, 300);

    const rawCode = errorBody.code || errorBody.error_code || error?.code || 'PAYMENT_CREATE_FAILED';
    return {
        status: Number.isInteger(error?.response?.status) ? error.response.status : null,
        code: String(rawCode).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'PAYMENT_CREATE_FAILED',
        message
    };
}

function safeOrderError(error) {
    const secrets = [
        process.env.DATABASE_URL,
        process.env.SUPABASE_SERVICE_ROLE_KEY,
        process.env.CASHFREE_SECRET_KEY
    ].filter(Boolean);
    let message = String(error?.message || 'Unknown order creation error');
    for (const secret of secrets) {
        message = message.split(secret).join('[redacted]');
    }
    message = message
        .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1[redacted]@')
        .replace(/cfsk_[a-zA-Z0-9_-]+/g, '[redacted]')
        .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1[redacted]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
        .replace(/\b[6-9][0-9]{9}\b/g, '[redacted]');
    return {
        code: String(error?.code || 'ORDER_CREATE_FAILED').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
        message: message.slice(0, 300)
    };
}

// ── Order Configuration ─────────────────────
const PRICING = {
    single: 2,
    double: 3,
    serviceCharge: 3,
    hostelSurcharge: 4,
    classroomDelivery: 10
};

/**
 * Printing cost for one file. B&W double-sided is charged per physical sheet
 * (2 PDF pages per sheet, rounded up per copy); B&W single-sided and colour stay per page.
 * Keep in sync with filePrintingCost() in client-react/src/pages/NewOrder.jsx and Home.jsx.
 */
function filePrintingCost(f) {
    const pages = Number(f.pages) || 0;
    const copies = Number(f.copies) || 1;
    if (f.colorMode === 'color') return pages * copies * 5;
    if (f.printingSide === 'double') return Math.ceil(pages / 2) * copies * PRICING.double;
    return pages * copies * PRICING.single;
}

// Upper bound on a user-declared page count (for file types we can't count
// server-side) so a tampered/huge value can't produce an absurd charge.
const MAX_DECLARED_PAGES = 2000;

// Sums the trusted amount from SERVER-RESOLVED files. Rates and the
// service/delivery rules are unchanged from the previous implementation.
function priceResolved(resolvedFiles, { collectionLocationId, classroomDelivery }) {
    if (!resolvedFiles || resolvedFiles.length === 0) return 0;
    let printingCost = 0;
    for (const f of resolvedFiles) printingCost += filePrintingCost(f);
    const serviceCharge = PRICING.serviceCharge;
    let deliveryCharge = 0;
    if (collectionLocationId === 'hostel-gate') {
        deliveryCharge = PRICING.hostelSurcharge;
    } else if (classroomDelivery === 'true' || classroomDelivery === true) {
        deliveryCharge = PRICING.classroomDelivery;
    }
    return printingCost + serviceCharge + deliveryCharge;
}

/**
 * The single source of truth for amount + per-file data. Validates each
 * uploaded file's type (extension + magic bytes), derives the page count from
 * the actual bytes where reliable, and — only for types with no reliable
 * server-side count — falls back to the user-declared count (clamped ≥1), which
 * the shop confirms at processing. The frontend NEVER dictates the amount.
 *
 * Throws an Error with .code / .httpStatus for an invalid upload.
 * Returns { resolved, amount }.
 */
async function resolveAndPriceFiles(files, fileSettingsRaw, { collectionLocationId, classroomDelivery }) {
    if (!files || files.length === 0) {
        const e = new Error('Please upload at least one file to continue.');
        e.code = 'NO_FILES'; e.httpStatus = 400; throw e;
    }
    let settings = [];
    try {
        settings = fileSettingsRaw
            ? (typeof fileSettingsRaw === 'string' ? JSON.parse(fileSettingsRaw) : fileSettingsRaw)
            : [];
    } catch {
        settings = [];
    }

    const resolved = [];
    for (const [idx, file] of files.entries()) {
        const type = fileTypes.resolveFileType(file.originalname, file.mimetype);
        if (!type) {
            const e = new Error(`Unsupported file type: ${file.originalname}`);
            e.code = 'UNSUPPORTED_FILE_TYPE'; e.httpStatus = 400; throw e;
        }
        if (!fileTypes.validateMagic(file.buffer, type.family)) {
            const e = new Error(`${file.originalname} does not look like a valid ${type.label} file.`);
            e.code = 'FILE_CONTENT_MISMATCH'; e.httpStatus = 400; throw e;
        }

        const det = await detectPages(file);
        const setting = settings[idx] || {};
        let pages;
        let estimated;
        if (!det.estimated && det.pages >= 1) {
            // Reliable server-side count — ignore any client-sent page value.
            pages = det.pages;
            estimated = false;
        } else {
            // No reliable count: use the user-declared count, clamped to a sane range.
            const declared = parseInt(setting.pages, 10);
            pages = Math.max(1, Math.min(MAX_DECLARED_PAGES, Number.isFinite(declared) ? declared : 1));
            estimated = true;
        }

        resolved.push({
            file,
            originalname: file.originalname,
            mimetype: type.mime,
            size: file.size,
            fileType: type.label,
            pages,
            estimated,
            copies: Math.max(1, parseInt(setting.copies, 10) || 1),
            printingSide: setting.printingSide === 'double' ? 'double' : 'single',
            colorMode: setting.colorMode === 'color' ? 'color' : 'bw'
        });
    }

    const amount = priceResolved(resolved, { collectionLocationId, classroomDelivery });
    return { resolved, amount };
}

// @route  GET /api/orders/config
router.get('/config', (req, res) => {
    res.json({
        pricing: PRICING,
        locations: slots.LOCATIONS
    });
});

// Single-shop deployment today: new orders always go to shop id 1.
// (Shop selection would be added here if/when multiple shops go live.)
const DEFAULT_SHOP_ID = 1;

// ── Auth middleware ──────────────────────────────
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) return next();
    res.status(401).json({ message: 'Not authenticated' });
}

// GET /api/orders/slots
//   (no query)           → all time slots with 5-minute cutoff
//   ?time=2:05 PM        → locations offered / unavailable for that slot
//   ?location=main-gate  → times for one location (legacy)
router.get('/slots', async (req, res) => {
    try {
        const time = req.query.time;
        const locationId = req.query.location;

        if (time) {
            if (!slots.TIME_SLOTS.includes(time)) {
                return res.status(400).json({ message: 'Unknown time slot' });
            }
            let countsByLocation = {};
            if (slots.LIVE_SLOT_AVAILABILITY) {
                const [rows] = await pool.query(
                    `SELECT collection_location_id, COUNT(*) AS count
                     FROM orders
                     WHERE collection_time = ?
                       AND DATE(created_at) = CURDATE()
                       AND payment_status = 'PAID'
                       AND status NOT IN ('rejected','cancelled')
                     GROUP BY collection_location_id`,
                    [time]
                );
                rows.forEach(r => { countsByLocation[r.collection_location_id] = r.count; });
            }
            return res.json({
                time,
                locations: slots.buildLocationStatusesForTime(time, countsByLocation),
                ...slots.getOrderDateContext()
            });
        }

        if (locationId) {
            const location = slots.getLocationById(locationId);
            if (!location) return res.status(400).json({ message: 'Unknown location' });

            let countsByTime = {};
            if (slots.LIVE_SLOT_AVAILABILITY) {
                const [rows] = await pool.query(
                    `SELECT collection_time, COUNT(*) AS count
                     FROM orders
                     WHERE collection_location_id = ?
                       AND DATE(created_at) = CURDATE()
                       AND payment_status = 'PAID'
                       AND status NOT IN ('rejected','cancelled')
                     GROUP BY collection_time`,
                    [locationId]
                );
                rows.forEach(r => { countsByTime[r.collection_time] = r.count; });
            }

            return res.json({ location, slots: slots.buildSlotStatuses(locationId, countsByTime) });
        }

        res.json({ slots: slots.buildTimeSlotStatuses(), ...slots.getOrderDateContext() });
    } catch (err) {
        console.error('Slots error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// GET /api/orders/stats
router.get('/stats', async (req, res) => {
    try {
        if (!req.session || !req.session.userId) {
            return res.json({ total: 0, in_progress: 0, ready: 0 });
        }
        const stats = await Order.getOrderStats(req.session.userId);
        res.json(stats);
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// GET /api/orders/payment-options — public details shown during checkout.
router.get('/payment-options', async (req, res) => {
    try {
        const shop = await Shop.getShopById(DEFAULT_SHOP_ID);
        res.json({
            phone: shop?.phone || null,
            upi: shop?.payment_upi || null,
            hasQr: !!shop?.payment_qr_path,
            // Path changes on every upload, so it doubles as a cache-buster for the image URL.
            qrVersion: shop?.payment_qr_path ? encodeURIComponent(shop.payment_qr_path.split('/').pop()) : null
        });
    } catch (error) {
        console.error('Payment options error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

// GET /api/orders/payment-options/qr — serves the private shop QR image.
router.get('/payment-options/qr', async (req, res) => {
    try {
        const shop = await Shop.getShopById(DEFAULT_SHOP_ID);
        if (!shop?.payment_qr_path) {
            return res.status(404).json({ message: 'No payment QR configured' });
        }
        const buffer = await downloadFile(shop.payment_qr_path);
        res.setHeader('Content-Type', shop.payment_qr_mime || 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.send(buffer);
    } catch (error) {
        console.error('Payment QR error:', error);
        res.status(500).json({ message: 'Server Error' });
    }
});

// ── Guest order recovery (phone → OTP → recovery session) ───────────────────
// These are declared before GET '/:id' so '/lookup', '/verify-recovery' and
// '/history' are never swallowed by the ':id' route.

// POST /api/orders/lookup — start recovery: validate phone, issue an OTP.
// Always responds generically; it never reveals whether orders exist for a phone.
router.post('/lookup', lookupLimiter, async (req, res) => {
    try {
        const phone = normalizePhone(req.body?.phone);
        if (!phone) {
            return res.status(400).json({ message: 'Enter a valid 10-digit mobile number.', code: 'INVALID_PHONE' });
        }

        const otp = await RecoveryOtp.createOtp(phone);
        const { devOtp } = await otpService.sendOtp(phone, otp);
        RecoveryOtp.cleanupExpired().catch(() => {});

        const response = {
            message: 'If this number has placed orders, a verification code has been sent.',
            phoneMasked: maskPhone(phone),
            // The OTP is echoed back ONLY outside production (no SMS provider wired yet).
            otpDeliveryConfigured: !otpService.isProduction()
        };
        if (devOtp) {
            response.devOtp = devOtp;
            response.devNote = 'Development mode: OTP shown for testing only. Never returned in production.';
        }
        return res.json(response);
    } catch (err) {
        console.error('[RECOVERY_LOOKUP_FAILED]', err.message);
        return res.status(500).json({ message: 'Unable to start recovery right now. Please retry.' });
    }
});

// POST /api/orders/verify-recovery — verify OTP, open a short-lived recovery session.
router.post('/verify-recovery', verifyLimiter, async (req, res) => {
    try {
        const phone = normalizePhone(req.body?.phone);
        const otp = String(req.body?.otp || '').trim();
        if (!phone) {
            return res.status(400).json({ message: 'Enter a valid 10-digit mobile number.', code: 'INVALID_PHONE' });
        }
        if (!/^[0-9]{6}$/.test(otp)) {
            return res.status(400).json({ message: 'Enter the 6-digit verification code.', code: 'INVALID_OTP' });
        }

        const result = await RecoveryOtp.verifyOtp(phone, otp);
        if (!result.ok) {
            const msg = result.reason === 'locked'
                ? 'Too many incorrect attempts. Request a new code.'
                : 'That code is invalid or has expired. Please try again.';
            return res.status(400).json({ message: msg, code: 'OTP_VERIFICATION_FAILED' });
        }

        establishRecoverySession(req, phone);
        return res.json({ verified: true, phoneMasked: maskPhone(phone) });
    } catch (err) {
        console.error('[RECOVERY_VERIFY_FAILED]', err.message);
        return res.status(500).json({ message: 'Unable to verify right now. Please retry.' });
    }
});

// GET /api/orders/history — orders for the verified recovery session's phone.
router.get('/history', historyLimiter, requireRecoverySession, async (req, res) => {
    try {
        const orders = await Order.getGuestOrdersByPhone(req.recoveryPhone);
        return res.json({
            phoneMasked: maskPhone(req.recoveryPhone),
            orders: orders.map(toRecoveryOrderSummary)
        });
    } catch (err) {
        console.error('[RECOVERY_HISTORY_FAILED]', err.message);
        return res.status(500).json({ message: 'Unable to load your orders right now. Please retry.' });
    }
});

// GET /api/orders/:id — single order ticket. Requires recovery session (matching
// guest_phone), a valid ticket token for this order, or account ownership.
router.get('/:id', ticketLimiter, async (req, res) => {
    let stage = 'order_lookup';
    console.info('[TICKET_LOAD] Ticket lookup started:', { orderId: req.params.id });
    try {
        const order = await Order.getOrderById(req.params.id);
        if (!order) {
            console.warn('[TICKET_LOAD_FAILED]', {
                stage,
                orderId: req.params.id,
                status: 404,
                error_code: 'ORDER_NOT_FOUND',
                message: 'No order matched the requested ticket ID.'
            });
            return res.status(404).json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
        }

        // A bare order id is never sufficient: require token / recovery session / ownership.
        if (!isAuthorizedForOrder(req, order)) {
            console.warn('[TICKET_LOAD_DENIED]', { orderId: req.params.id, status: 403 });
            return res.status(403).json({
                message: 'This ticket link is no longer valid. Recover your order from the Orders page.',
                code: 'TICKET_NOT_AUTHORIZED'
            });
        }

        stage = 'payment_lookup';
        const [[payment]] = await pool.query(
            `SELECT transaction_ref, method, amount FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
            [order.id]
        );
        console.info('[TICKET_LOAD] Ticket lookup succeeded:', {
            orderId: req.params.id,
            paymentRecordPresent: Boolean(payment)
        });
        // Never ship the full phone number to the client; the ticket shows a mask.
        res.json({ ...order, guest_phone: maskPhone(order.guest_phone), payment: payment || null });
    } catch (err) {
        const safeError = safeOrderError(err);
        console.error('[TICKET_LOAD_FAILED]', {
            stage,
            orderId: req.params.id,
            error_code: safeError.code,
            message: safeError.message
        });
        res.status(500).json({
            message: 'Unable to load this ticket right now. Please retry.',
            code: 'TICKET_LOAD_FAILED'
        });
    }
});

// GET /api/orders/:id/payment-status — recovery-authorized payment reconcile.
// Reads the DB (source of truth updated by the Cashfree webhook) and, if still
// pending with a gateway order id, does a READ-ONLY Cashfree re-check (same
// sandbox/production config as everywhere else — no new/ production requests,
// no order creation). Never flips a payment to failed from the frontend's view.
router.get('/:id/payment-status', pollLimiter, async (req, res) => {
    try {
        const order = await Order.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
        if (!isAuthorizedForOrder(req, order)) {
            return res.status(403).json({ message: 'Not authorized for this order.', code: 'TICKET_NOT_AUTHORIZED' });
        }

        let payment = await Payment.findByOrderId(order.id);
        if (payment && payment.status === 'pending' && payment.gateway_order_id && paymentGatewayReady()) {
            try {
                const cfOrder = await cashfree.fetchOrder(payment.gateway_order_id);
                if (cashfree.isOrderPaid(cfOrder)) {
                    payment = await Payment.updateByGatewayOrderId(payment.gateway_order_id, { status: 'success' });
                }
            } catch (reconcileErr) {
                // Non-fatal: fall back to the stored status. Do NOT mark failed here.
                console.warn('[PAYMENT_STATUS_RECONCILE]', safeOrderError(reconcileErr).message);
            }
        }

        // A still-pending UPI QR whose QR window has lapsed is reported EXPIRED (the
        // DB row stays 'pending' so the order remains payable via a refreshed QR).
        let paymentStatus = paymentStatusLabel(payment?.status);
        if (payment && payment.status === 'pending' && payment.qr_expires_at
            && new Date(payment.qr_expires_at).getTime() < Date.now()) {
            paymentStatus = 'EXPIRED';
        }

        return res.json({
            orderId: order.id,
            ticketId: order.ticket_number || `CP-${String(order.id).padStart(3, '0')}`,
            paymentStatus,
            paymentReference: payment?.payment_reference || null,
            ticketStatus: ticketStatusLabel(order.status),
            ticketToken: payment && payment.status === 'success' ? ticketToken.sign(order.id) : null
        });
    } catch (err) {
        console.error('[PAYMENT_STATUS_FAILED]', safeOrderError(err).message);
        return res.status(500).json({ message: 'Unable to check payment status right now. Please retry.' });
    }
});

// GET /api/orders/:id/documents — authorized document list (metadata only, no binaries).
router.get('/:id/documents', documentLimiter, async (req, res) => {
    try {
        const order = await Order.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
        if (!isAuthorizedForOrder(req, order)) {
            return res.status(403).json({ message: 'Not authorized for this order.', code: 'TICKET_NOT_AUTHORIZED' });
        }

        const files = await OrderFile.getFilesByOrder(order.id);
        const documents = files.map(f => ({
            fileId: f.id,
            name: f.original_name,
            sizeBytes: f.size_bytes,
            // Uploaded PDFs are purged after 24h; surface that instead of a dead link.
            expired: Boolean(f.file_deleted_at),
            createdAt: f.created_at
        }));
        return res.json({ orderId: order.id, documents });
    } catch (err) {
        console.error('[DOCUMENTS_LIST_FAILED]', safeOrderError(err).message);
        return res.status(500).json({ message: 'Unable to load documents right now. Please retry.' });
    }
});

// GET /api/orders/:id/documents/:fileId — stream one document, authorized for THIS order.
// Changing :id or :fileId to another order's values fails authorization / ownership.
router.get('/:id/documents/:fileId', documentLimiter, async (req, res) => {
    try {
        const order = await Order.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
        if (!isAuthorizedForOrder(req, order)) {
            return res.status(403).json({ message: 'Not authorized for this order.', code: 'TICKET_NOT_AUTHORIZED' });
        }

        const file = await OrderFile.getFileById(req.params.fileId);
        // The file must belong to this exact order — blocks IDOR via a mismatched file id.
        if (!file || String(file.order_id) !== String(order.id)) {
            return res.status(404).json({ message: 'File not found', code: 'FILE_NOT_FOUND' });
        }
        return await sendStoredFile(res, file, { download: req.query.download === '1' || req.query.download === 'true' });
    } catch (err) {
        console.error('[DOCUMENT_FETCH_FAILED]', safeOrderError(err).message);
        return res.status(500).json({ message: 'Unable to load this document right now. Please retry.' });
    }
});

// POST /api/orders/detect-pages — auto-detects page count per uploaded file (PDF/DOCX get a
// real count; images are always 1; anything else falls back to a flagged 1-page estimate).
router.post('/detect-pages', detectUpload.array('files', 10), async (req, res) => {
    try {
        const files = req.files || [];
        if (files.length === 0) {
            return res.status(400).json({ message: 'No files uploaded for page detection.' });
        }
        const results = await Promise.all(files.map(async (f) => {
            const type = fileTypes.resolveFileType(f.originalname, f.mimetype);
            if (!type || !fileTypes.validateMagic(f.buffer, type.family)) {
                return { name: f.originalname, fileType: null, mimeType: f.mimetype, pages: null, estimated: true, unsupported: true };
            }
            const { pages, estimated } = await detectPages(f);
            // For estimated types (no reliable server count) the UI shows an
            // editable page-count field; `estimated` drives that, `pages` is the
            // ≥1 starting value.
            return {
                name: f.originalname,
                fileType: type.label,
                mimeType: type.mime,
                pages,
                estimated
            };
        }));
        res.json({ files: results });
    } catch (err) {
        console.error('Detect pages error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// GET /api/orders
router.get('/', async (req, res) => {
    try {
        if (!req.session || !req.session.userId) {
            return res.json([]);
        }
        const orders = await Order.getOrdersByUser(req.session.userId);
        res.json(orders);
    } catch (err) {
        console.error('Get orders error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// Persists the SERVER-RESOLVED files (from resolveAndPriceFiles): uploads each
// buffer under a generated path and stores its authoritative type + page count.
async function persistUploadedFiles(userId, orderId, resolvedFiles, onStage = () => {}) {
    const finalFiles = [];

    for (const [index, rf] of resolvedFiles.entries()) {
        const { storedName, storagePath } = buildObjectPath(userId, orderId, rf.originalname);
        onStage('file_storage_upload');
        console.info('[ORDER_CREATE] File storage upload started:', {
            orderId,
            fileIndex: index + 1,
            fileCount: resolvedFiles.length,
            sizeBytes: rf.size
        });
        await uploadBuffer({
            storagePath,
            buffer: rf.file.buffer,
            contentType: rf.mimetype
        });
        console.info('[ORDER_CREATE] File storage upload completed:', {
            orderId,
            fileIndex: index + 1,
            fileCount: resolvedFiles.length
        });

        finalFiles.push({
            originalname: rf.originalname,
            storedName,
            storagePath,
            mimetype: rf.mimetype,
            size: rf.size,
            fileType: rf.fileType,
            pageCount: rf.pages,
            printingSide: rf.printingSide,
            copies: rf.copies,
            colorMode: rf.colorMode
        });
    }

    onStage('file_metadata_insert');
    console.info('[ORDER_CREATE] File metadata insert started:', {
        orderId,
        fileCount: finalFiles.length
    });
    await OrderFile.createFiles(orderId, finalFiles);
    console.info('[ORDER_CREATE] File metadata insert completed:', {
        orderId,
        fileCount: finalFiles.length
    });
}

function readOrderPayload(body) {
    return {
        colorOption: body.colorOption,
        paperSize: body.paperSize,
        copies: Number(body.copies),
        spiralBinding: body.spiralBinding === 'true' || body.spiralBinding === true,
        expressDelivery: body.expressDelivery === 'true' || body.expressDelivery === true,
        totalPages: Number(body.totalPages) || 0,
        totalPrice: Number(body.totalPrice),
        collectionLocationId: body.collectionLocationId || null,
        collectionLocationName: body.collectionLocation || null,
        collectionTime: body.collectionTime || null,
        collectionDate: slots.getOrderDateContext().date,
        classroomDelivery: body.classroomDelivery === 'true' || body.classroomDelivery === true,
        guestFullName: body.fullName || null,
        guestPhone: body.phone || null,
        guestClassroom: body.classroom || null
    };
}

// POST /api/orders/payment/create — creates a Cashfree order and returns a payment session.
// Multipart: the actual files are sent so the backend can derive the trusted
// amount from their real content (never from a client-supplied price).
router.post('/payment/create', upload.array('files', 10), async (req, res) => {
    let stage = 'gateway_configuration';
    const body = req.body || {};
    let fileSettingsCount = null;
    try {
        const settings = typeof body.fileSettings === 'string'
            ? JSON.parse(body.fileSettings)
            : body.fileSettings;
        fileSettingsCount = Array.isArray(settings) ? settings.length : null;
    } catch {
        fileSettingsCount = null;
    }
    console.info('[PAYMENT_CREATE] Request received:', {
        hasTotalPrice: body.totalPrice != null,
        hasFullName: Boolean(body.fullName),
        hasPhone: Boolean(body.phone),
        hasClassroom: Boolean(body.classroom),
        fileSettingsCount
    });

    const gatewayConfigured = paymentGatewayReady();
    let cashfreeEnvironment = 'unknown';
    if (gatewayConfigured) {
        try {
            cashfreeEnvironment = cashfree.getMode();
        } catch {
            cashfreeEnvironment = 'invalid';
        }
    }
    console.info('[PAYMENT_CREATE] Gateway configuration:', {
        appIdPresent: Boolean(process.env.CASHFREE_APP_ID),
        secretPresent: Boolean(process.env.CASHFREE_SECRET_KEY),
        cashfreeEnvConfigured: Boolean(process.env.CASHFREE_ENV),
        environment: cashfreeEnvironment
    });

    if (!gatewayConfigured) {
        console.error('[PAYMENT_CREATE_FAILED]', {
            stage,
            code: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
            message: 'Cashfree application ID or secret key is missing.'
        });
        return res.status(503).json({
            message: 'Payment gateway is not configured on the server.',
            code: 'PAYMENT_GATEWAY_NOT_CONFIGURED'
        });
    }

    try {
        stage = 'request_validation';
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ message: 'Please upload at least one file to continue.', code: 'NO_FILES' });
        }
        // Trusted, content-derived amount. Page counts come from the actual file
        // bytes (or a user-declared count for types we can't count); the
        // client-sent totalPrice is ignored entirely.
        let verifiedAmount;
        try {
            const priced = await resolveAndPriceFiles(req.files, req.body.fileSettings, {
                collectionLocationId: req.body.collectionLocationId,
                classroomDelivery: req.body.classroomDelivery
            });
            verifiedAmount = priced.amount;
        } catch (resolveErr) {
            console.error('[PAYMENT_CREATE_FAILED]', { stage, code: resolveErr.code || 'FILE_VALIDATION_FAILED', message: resolveErr.message });
            return res.status(resolveErr.httpStatus || 400).json({ message: resolveErr.message, code: resolveErr.code || 'FILE_VALIDATION_FAILED' });
        }

        if (!verifiedAmount || verifiedAmount <= 0) {
            console.error('[PAYMENT_CREATE_FAILED]', {
                stage,
                status: 400,
                code: 'INVALID_ORDER_AMOUNT',
                message: 'Server-side order amount is missing or invalid.'
            });
            return res.status(400).json({ message: 'Invalid order amount' });
        }
        console.info('[PAYMENT_CREATE] Validation passed:', {
            stage,
            amount: verifiedAmount,
            fileSettingsCount
        });

        const { fullName, phone, classroom } = req.body;
        if (!fullName || !phone || !classroom || !classroom.trim()) {
            console.error('[PAYMENT_CREATE_FAILED]', {
                stage,
                status: 400,
                code: 'CUSTOMER_FIELDS_REQUIRED',
                message: 'Required customer fields are missing.'
            });
            return res.status(400).json({ message: 'Full Name, Phone, and Classroom/Room Number are required.' });
        }

        // Backend format validation for required fields
        const phoneRegex = /^[6-9][0-9]{9}$/;
        if (!phoneRegex.test(phone)) {
            console.error('[PAYMENT_CREATE_FAILED]', {
                stage,
                status: 400,
                code: 'INVALID_CUSTOMER_PHONE',
                message: 'Customer phone failed server-side validation.'
            });
            return res.status(400).json({ message: 'Enter a valid 10-digit mobile number.' });
        }

        if (classroom.trim().length < 2) {
            console.error('[PAYMENT_CREATE_FAILED]', {
                stage,
                status: 400,
                code: 'INVALID_CLASSROOM',
                message: 'Classroom/room number failed server-side validation.'
            });
            return res.status(400).json({ message: 'Please enter a valid classroom/room number.' });
        }

        // Optional field validation
        const { batch, classSection } = req.body;
        if (batch && !/^[0-9]{4}-[0-9]{s}*$/.test(batch)) { // Simple check, actual regex below
             // We'll apply the full regex here
        }
        if (batch) {
            const batchRegex = /^[0-9]{4}-[0-9]{4}$/;
            if (!batchRegex.test(batch)) {
                console.error('[PAYMENT_CREATE_FAILED]', {
                    stage,
                    status: 400,
                    code: 'INVALID_BATCH',
                    message: 'Batch failed server-side validation.'
                });
                return res.status(400).json({ message: 'Enter batch in YYYY-YYYY format (e.g. 2024-2028).' });
            }
        }
        if (classSection && /^\d+$/.test(classSection)) {
            console.error('[PAYMENT_CREATE_FAILED]', {
                stage,
                status: 400,
                code: 'INVALID_CLASS_SECTION',
                message: 'Class/section failed server-side validation.'
            });
            return res.status(400).json({ message: 'Enter a valid class/section (e.g. CSE-A).' });
        }

        // Validate Indian Phone Number
        if (!phoneRegex.test(phone)) {
            console.error('[PAYMENT_CREATE_FAILED]', {
                stage,
                status: 400,
                code: 'INVALID_CUSTOMER_PHONE',
                message: 'Customer phone failed server-side validation.'
            });
            return res.status(400).json({ message: 'Please provide a valid 10-digit Indian mobile number.' });
        }

        const User = require('../models/User');
        const userId = req.session?.userId || null;
        stage = 'customer_lookup';
        const user = userId ? await User.findById(userId) : null;
        console.info('[PAYMENT_CREATE] Customer data prepared:', {
            stage,
            authenticatedUser: Boolean(userId),
            emailAvailable: Boolean(user?.email),
            phoneAvailable: Boolean(phone)
        });

        const cashfreeOrderId = `cp_${crypto.randomUUID()}`;
        const requestOrigin = req.get('origin') || '';
        const localFrontendOrigin = /^http:\/\/localhost(?::\d+)?$/.test(requestOrigin)
            ? requestOrigin
            : '';
        const frontend = (localFrontendOrigin || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
        const publicApi = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
        let webhookOrigin = '';
        try {
            const parsedApi = new URL(publicApi);
            if (parsedApi.protocol === 'https:' && parsedApi.pathname === '/' &&
                !parsedApi.search && !parsedApi.hash && !parsedApi.username && !parsedApi.password) {
                webhookOrigin = parsedApi.origin;
            }
        } catch {
            // The production configuration check below reports an actionable error.
        }
        if (process.env.NODE_ENV === 'production' && !webhookOrigin) {
            return res.status(503).json({
                message: 'Cashfree payments require PUBLIC_API_URL to be a public HTTPS API origin.',
                code: 'PAYMENT_WEBHOOK_URL_REQUIRED'
            });
        }
        const notifyUrl = webhookOrigin ? `${webhookOrigin}/api/orders/payment/webhook` : undefined;
        const returnUrl = `${frontend}/new-order?cf_order={order_id}`;
        let returnOrigin = 'invalid';
        try {
            returnOrigin = new URL(returnUrl).origin;
        } catch {
            // Keep diagnostics safe if a malformed return URL is configured.
        }

        const data = readOrderPayload(body);
        data.totalPrice = verifiedAmount;
        data.fileCount = files.length;
        const pickupErr = slots.pickupError(data.collectionLocationId, data.collectionTime);
        if (pickupErr) return res.status(400).json({ message: pickupErr });

        stage = 'order_intent_persistence';
        const ticketToken = createTicketToken(cashfreeOrderId);
        const order = await Order.createPaymentIntent(userId, DEFAULT_SHOP_ID, data, {
            gatewayOrderId: cashfreeOrderId,
            ticketTokenHash: hashTicketToken(ticketToken)
        });
        try {
            await persistUploadedFiles(userId, order.id, files, JSON.stringify(fileSettings), currentStage => {
                stage = currentStage;
            });
        } catch (error) {
            await Order.failPayment(cashfreeOrderId);
            throw error;
        }

        stage = 'cashfree_order_create';
        console.info('[PAYMENT_SUCCESS] Cashfree return URL configured:', {
            frontendOrigin: returnOrigin,
            returnPath: '/new-order',
            orderIdParameter: 'cf_order'
        });
        const environment = cashfree.getMode();
        const endpoint = `${environment === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com'}/pg/orders`;
        console.info('[PAYMENT_CREATE] Calling Cashfree:', {
            stage,
            endpoint,
            environment,
            appIdPresent: Boolean(process.env.CASHFREE_APP_ID),
            secretPresent: Boolean(process.env.CASHFREE_SECRET_KEY),
            cashfreeEnvConfigured: Boolean(process.env.CASHFREE_ENV),
            orderId: cashfreeOrderId,
            amount: verifiedAmount,
            returnOrigin
        });
        console.info('[PAYMENT_CREATE] Cashfree request prepared:', {
            orderId: cashfreeOrderId,
            amount: verifiedAmount,
            returnOrigin,
            notifyUrlConfigured: Boolean(notifyUrl)
        });

        const session = await cashfree.createPaymentSession({
            orderId: cashfreeOrderId,
            amount: verifiedAmount,
            customerId: `cust_${userId || 'guest'}_${Date.now()}`,
            customerEmail: user?.email || `${phone}@guest.campusprint.com`,
            customerPhone: phone,
            returnUrl,
            notifyUrl
        });
        console.info('[PAYMENT_CREATE] Cashfree response received:', {
            orderId: cashfreeOrderId,
            paymentSessionReturned: Boolean(session.paymentSessionId),
            orderStatus: session.orderStatus || 'unknown'
        });

        stage = 'payment_session_validation';
        if (!session.paymentSessionId || session.cashfreeOrderId !== cashfreeOrderId ||
            !cashfree.amountsMatch(session.orderAmount, verifiedAmount)) {
            const mismatch = Boolean(session.paymentSessionId) &&
                (session.cashfreeOrderId !== cashfreeOrderId || !cashfree.amountsMatch(session.orderAmount, verifiedAmount));
            console.error('[PAYMENT_CREATE_FAILED]', {
                stage,
                status: 502,
                code: mismatch ? 'CASHFREE_ORDER_MISMATCH' : 'PAYMENT_SESSION_MISSING',
                message: 'Cashfree response did not match the persisted order intent.',
                orderStatus: session.orderStatus || 'unknown'
            });
            return res.status(502).json({
                message: 'Cashfree did not return a valid payment session. Please try again.',
                code: mismatch ? 'CASHFREE_ORDER_MISMATCH' : 'PAYMENT_SESSION_MISSING'
            });
        }

        console.info('[PAYMENT_CREATE] Payment session created:', {
            orderId: cashfreeOrderId,
            paymentSessionReturned: true,
            orderStatus: session.orderStatus || 'unknown'
        });
        res.json({
            paymentSessionId: session.paymentSessionId,
            cashfreeOrderId,
            mode: cashfree.getMode()
        });
    } catch (err) {
        const details = paymentCreateErrorDetails(err);
        console.error('[PAYMENT_CREATE_FAILED]', {
            stage,
            status: details.status,
            code: details.code,
            message: details.message
        });
        res.status(details.status && details.status >= 400 && details.status < 600 ? details.status : 503).json({
            message: details.message,
            code: details.code
        });
    }
});

async function createGuestOrder(req, res, payment) {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ message: 'Please upload at least one file to continue.' });
        }
        if (!req.body.fileSettings) {
            return res.status(400).json({ message: 'Please configure printing settings for all files.' });
        }

        const { fullName, phone, classroom } = req.body;
        if (!fullName || !phone || !classroom || !classroom.trim()) {
            return res.status(400).json({ message: 'Full Name, Phone, and Classroom/Room Number are required.' });
        }

        // Backend format validation for required fields
        const phoneRegex = /^[6-9][0-9]{9}$/;
        if (!phoneRegex.test(phone)) {
            return res.status(400).json({ message: 'Enter a valid 10-digit mobile number.' });
        }

        if (classroom.trim().length < 2) {
            return res.status(400).json({ message: 'Please enter a valid classroom/room number.' });
        }

        // Optional field validation
        const { batch, classSection } = req.body;
        if (batch && !/^[0-9]{4}-[0-9]{s}*$/.test(batch)) { // Simple check, actual regex below
             // We'll apply the full regex here
        }
        if (batch) {
            const batchRegex = /^[0-9]{4}-[0-9]{4}$/;
            if (!batchRegex.test(batch)) {
                return res.status(400).json({ message: 'Enter batch in YYYY-YYYY format (e.g. 2024-2028).' });
            }
        }
        if (classSection && /^\d+$/.test(classSection)) {
            return res.status(400).json({ message: 'Enter a valid class/section (e.g. CSE-A).' });
        }

        // Validate Indian Phone Number
        if (!phoneRegex.test(phone)) {
            return res.status(400).json({ message: 'Please provide a valid 10-digit Indian mobile number.' });
        }

        const data = readOrderPayload(req.body);
        const pickupErr = slots.pickupError(data.collectionLocationId, data.collectionTime);
        if (pickupErr) return res.status(400).json({ message: pickupErr });

        // Server-side, content-derived price + resolved files (ignores any client price).
        let resolved;
        try {
            const priced = await resolveAndPriceFiles(req.files, req.body.fileSettings, {
                collectionLocationId: data.collectionLocationId,
                classroomDelivery: req.body.classroomDelivery
            });
            resolved = priced.resolved;
            data.totalPrice = priced.amount;
        } catch (resolveErr) {
            return res.status(resolveErr.httpStatus || 400).json({ message: resolveErr.message, code: resolveErr.code || 'FILE_VALIDATION_FAILED' });
        }

        data.fileCount = resolved.length;
        data.guestFullName = fullName;
        data.guestPhone = phone;
        data.guestClassroom = classroom;

        const userId = req.session?.userId || null;
        const order = await Order.createOrder(userId, DEFAULT_SHOP_ID, data);
        await persistUploadedFiles(userId, order.id, resolved);
        await Payment.createForOrder(order.id, userId, DEFAULT_SHOP_ID, data.totalPrice || 0, payment.method, payment.transactionRef, { status: payment.status });

        res.status(201).json({ id: order.id, ticketNumber: order.ticketNumber, ticketToken: ticketToken.sign(order.id) });
    } catch (err) {
        console.error(`${payment.method} order error:`, err);
        res.status(500).json({ message: 'Server Error' });
    }
}

// Explicit simulation endpoint; payment-session failures never fall back to it automatically.
router.post('/payment/simulate', upload.array('files', 10), (req, res) => {
    if (process.env.NODE_ENV === 'production') {
        return res.status(404).json({ message: 'Not found.' });
    }
    if (paymentGatewayReady()) {
        return res.status(400).json({ message: 'Cashfree is configured. Use the Cashfree checkout.' });
    }
    return createGuestOrder(req, res, {
        method: 'simulated',
        transactionRef: `TXN-SIM-${Date.now()}`,
        status: 'success'
    });
});

// Payment methods chosen in the booking flow that are settled outside the app. The order is
// created right away with a pending payment; the shop admin marks it paid once money arrives.
// Note: 'none' is intentionally NOT here — that option is now the Personal WhatsApp flow, a
// manual order handled entirely over chat that must never create an order/ticket here.
const OFFLINE_PAYMENT_METHODS = ['whatsapp'];

// POST /api/orders/payment/offline — QR Payment ('whatsapp'); settled outside the app
router.post('/payment/offline', upload.array('files', 10), (req, res) => {
    const method = req.body.paymentMethod;
    if (!OFFLINE_PAYMENT_METHODS.includes(method)) {
        return res.status(400).json({ message: 'Unknown payment method.' });
    }
    return createGuestOrder(req, res, { method, transactionRef: null, status: 'pending' });
});

// Shared validation for a guest order submission (files + customer fields + pickup).
// Returns { data, resolved, amount } or sends an error response and returns null.
async function validateAndPriceGuestSubmission(req, res) {
    if (!req.files || req.files.length === 0) {
        res.status(400).json({ message: 'Please upload at least one file to continue.' });
        return null;
    }
    if (!req.body.fileSettings) {
        res.status(400).json({ message: 'Please configure printing settings for all files.' });
        return null;
    }
    const { fullName, phone, classroom, batch, classSection } = req.body;
    if (!fullName || !phone || !classroom || !classroom.trim()) {
        res.status(400).json({ message: 'Full Name, Phone, and Classroom/Room Number are required.' });
        return null;
    }
    if (!/^[6-9][0-9]{9}$/.test(phone)) {
        res.status(400).json({ message: 'Enter a valid 10-digit mobile number.' });
        return null;
    }
    if (classroom.trim().length < 2) {
        res.status(400).json({ message: 'Please enter a valid classroom/room number.' });
        return null;
    }
    if (batch && !/^[0-9]{4}-[0-9]{4}$/.test(batch)) {
        res.status(400).json({ message: 'Enter batch in YYYY-YYYY format (e.g. 2024-2028).' });
        return null;
    }
    if (classSection && /^\d+$/.test(classSection)) {
        res.status(400).json({ message: 'Enter a valid class/section (e.g. CSE-A).' });
        return null;
    }

    const data = readOrderPayload(req.body);
    const pickupErr = slots.pickupError(data.collectionLocationId, data.collectionTime);
    if (pickupErr) { res.status(400).json({ message: pickupErr }); return null; }

    let resolved;
    let amount;
    try {
        const priced = await resolveAndPriceFiles(req.files, req.body.fileSettings, {
            collectionLocationId: data.collectionLocationId,
            classroomDelivery: req.body.classroomDelivery
        });
        resolved = priced.resolved;
        amount = priced.amount;
    } catch (e) {
        res.status(e.httpStatus || 400).json({ message: e.message, code: e.code || 'FILE_VALIDATION_FAILED' });
        return null;
    }
    if (!amount || amount <= 0) { res.status(400).json({ message: 'Invalid order amount' }); return null; }

    data.totalPrice = amount;
    data.fileCount = resolved.length;
    data.guestFullName = fullName;
    data.guestPhone = phone;
    data.guestClassroom = classroom;
    return { data, resolved, amount };
}

// POST /api/orders/payment/upi-qr — Pay via UPI QR (order-first, manual verification).
// Creates the order PENDING, persists a secure payment reference, and returns a dynamic
// UPI QR encoding the DB amount + reference. It NEVER marks the order paid — confirmation
// is manual (a shop admin marks it paid once the UPI transfer is verified).
router.post('/payment/upi-qr', upload.array('files', 10), async (req, res) => {
    try {
        const shop = await Shop.getShopById(DEFAULT_SHOP_ID);
        if (!shop?.payment_upi) {
            return res.status(503).json({ message: 'UPI payments are not set up. Please choose another method.', code: 'UPI_NOT_CONFIGURED' });
        }

        const validated = await validateAndPriceGuestSubmission(req, res);
        if (!validated) return undefined; // response already sent
        const { data, resolved, amount } = validated;

        const userId = req.session?.userId || null;
        const order = await Order.createOrder(userId, DEFAULT_SHOP_ID, data);
        await persistUploadedFiles(userId, order.id, resolved);

        const reference = upiQr.generatePaymentReference(order.id);
        const qrExpiresAt = new Date(Date.now() + UPI_QR_TTL_MS);
        await Payment.createForOrder(order.id, userId, DEFAULT_SHOP_ID, amount, 'upi_qr', reference, {
            status: 'pending', paymentReference: reference, qrExpiresAt
        });

        const upiUrl = upiQr.buildUpiUri({
            vpa: shop.payment_upi,
            payeeName: shop.shop_name || 'Campus Print',
            amount,
            reference,
            note: `Campus Print ${order.ticketNumber}`
        });
        const qrDataUrl = await upiQr.generateQrDataUrl(upiUrl);

        return res.status(201).json({
            success: true,
            id: order.id,
            orderId: order.ticketNumber,
            ticketNumber: order.ticketNumber,
            amount,
            paymentReference: reference,
            qrDataUrl,
            upiUrl,
            expiresAt: qrExpiresAt.toISOString(),
            ticketToken: ticketToken.sign(order.id)
        });
    } catch (err) {
        const safe = safeOrderError(err);
        console.error('[UPI_QR_CREATE_FAILED]', safe.message);
        return res.status(500).json({ message: 'Could not start UPI payment. Please retry.', code: safe.code });
    }
});

// POST /api/orders/payment/upi-qr/:id/refresh — regenerate the QR for an existing unpaid
// order (same order + reference; never creates a new order). Authorized by ticket token / session.
router.post('/payment/upi-qr/:id/refresh', ticketLimiter, async (req, res) => {
    try {
        const order = await Order.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
        if (!isAuthorizedForOrder(req, order)) {
            return res.status(403).json({ message: 'Not authorized for this order.', code: 'TICKET_NOT_AUTHORIZED' });
        }
        const payment = await Payment.findByOrderId(order.id);
        if (!payment || payment.method !== 'upi_qr') {
            return res.status(400).json({ message: 'No UPI payment for this order.' });
        }
        if (payment.status === 'success') {
            return res.status(409).json({ message: 'This order is already paid.', code: 'ALREADY_PAID' });
        }
        const shop = await Shop.getShopById(DEFAULT_SHOP_ID);
        if (!shop?.payment_upi) {
            return res.status(503).json({ message: 'UPI payments are not set up.', code: 'UPI_NOT_CONFIGURED' });
        }

        const qrExpiresAt = new Date(Date.now() + UPI_QR_TTL_MS);
        await Payment.refreshQrExpiry(order.id, qrExpiresAt);
        const reference = payment.payment_reference;
        const upiUrl = upiQr.buildUpiUri({
            vpa: shop.payment_upi,
            payeeName: shop.shop_name || 'Campus Print',
            amount: Number(payment.amount),
            reference,
            note: `Campus Print ${order.ticket_number || order.id}`
        });
        const qrDataUrl = await upiQr.generateQrDataUrl(upiUrl);
        return res.json({ success: true, amount: Number(payment.amount), paymentReference: reference, qrDataUrl, upiUrl, expiresAt: qrExpiresAt.toISOString() });
    } catch (err) {
        console.error('[UPI_QR_REFRESH_FAILED]', safeOrderError(err).message);
        return res.status(500).json({ message: 'Could not refresh the QR. Please retry.' });
    }
});

// POST /api/orders/payment/verify — confirms Cashfree order status, then creates the print order.
router.post('/payment/verify', upload.array('files', 10), async (req, res) => {
    let verificationStage = 'request_received';
    let cashfreeOrderId;
    if (!paymentGatewayReady()) {
        return res.status(503).json({
            status: 'PAYMENT_PENDING',
            message: 'Payment gateway is not configured.',
            code: 'PAYMENT_GATEWAY_NOT_CONFIGURED'
        });
    }
    try {
        cashfreeOrderId = req.body.cashfree_order_id || req.body.cashfreeOrderId;
        console.info('[PAYMENT_RETURN] Verification request received:', {
            orderIdPresent: Boolean(cashfreeOrderId),
            fileCount: req.files?.length || 0,
            fileSettingsPresent: Boolean(req.body.fileSettings)
        });
        verificationStage = 'request_validation';
        if (!cashfreeOrderId) {
            console.error('[PAYMENT_VERIFY_FAILED]', {
                stage: verificationStage,
                code: 'PAYMENT_ORDER_ID_MISSING',
                message: 'Cashfree order ID is missing.'
            });
            return res.status(400).json({ message: 'Missing payment order id' });
        }
        if (!req.files || req.files.length === 0) {
            console.error('[PAYMENT_VERIFY_FAILED]', {
                stage: verificationStage,
                code: 'ORDER_FILES_MISSING',
                message: 'No uploaded files were restored for verification.'
            });
            return res.status(400).json({ message: 'Please upload at least one file to continue.' });
        }
        if (!req.body.fileSettings) {
            console.error('[PAYMENT_VERIFY_FAILED]', {
                stage: verificationStage,
                code: 'FILE_SETTINGS_MISSING',
                message: 'Print file settings are missing.'
            });
            return res.status(400).json({ message: 'Please configure printing settings for all files.' });
        }

        const { fullName, phone, classroom } = req.body;
        if (!fullName || !phone || !classroom || !classroom.trim()) {
            return res.status(400).json({ message: 'Full Name, Phone, and Classroom/Room Number are required.' });
        }

        // Backend format validation for required fields
        const phoneRegex = /^[6-9][0-9]{9}$/;
        if (!phoneRegex.test(phone)) {
            return res.status(400).json({ message: 'Enter a valid 10-digit mobile number.' });
        }

        if (classroom.trim().length < 2) {
            return res.status(400).json({ message: 'Please enter a valid classroom/room number.' });
        }

        // Optional field validation
        const { batch, classSection } = req.body;
        if (batch && !/^[0-9]{4}-[0-9]{s}*$/.test(batch)) { // Simple check, actual regex below
             // We'll apply the full regex here
        }
        if (batch) {
            const batchRegex = /^[0-9]{4}-[0-9]{4}$/;
            if (!batchRegex.test(batch)) {
                return res.status(400).json({ message: 'Enter batch in YYYY-YYYY format (e.g. 2024-2028).' });
            }
        }
        if (classSection && /^\d+$/.test(classSection)) {
            return res.status(400).json({ message: 'Enter a valid class/section (e.g. CSE-A).' });
        }

        // Validate Indian Phone Number
        if (!phoneRegex.test(phone)) {
            return res.status(400).json({ message: 'Please provide a valid 10-digit Indian mobile number.' });
        }

        verificationStage = 'cashfree_status_verification';
        console.info('[PAYMENT_VERIFY] Verification started:', { cashfreeOrderId });
        const cfOrder = await cashfree.fetchOrderUntilPaid(cashfreeOrderId);
        console.info('[PAYMENT_VERIFY] Cashfree order status checked:', {
            cashfreeOrderId,
            paymentStatus: cfOrder.order_status || 'unknown',
            paid: cashfree.isOrderPaid(cfOrder)
        });
        if (!cashfree.isOrderPaid(cfOrder)) {
            console.warn('[PAYMENT_VERIFY_FAILED]', {
                stage: verificationStage,
                cashfreeOrderId,
                paymentStatus: cfOrder.order_status || 'unknown'
            });
            return res.status(400).json({ message: 'Payment is not completed yet. Please wait or try again.' });
        }
        console.info('[PAYMENT_VERIFY] Payment verified successfully:', { cashfreeOrderId });

        verificationStage = 'ticket_creation';
        console.info('[TICKET_CREATE] Starting ticket creation:', { cashfreeOrderId });
        const existing = await Payment.findByGatewayOrderId(cashfreeOrderId);
        if (existing && existing.order_id) {
            const prior = await Order.getOrderById(existing.order_id);
            if (prior) {
                console.info('[TICKET_CREATE] Existing ticket found:', {
                    cashfreeOrderId,
                    orderId: prior.id
                });
                return res.status(200).json({ id: prior.id, ticketNumber: prior.ticket_number, ticketToken: ticketToken.sign(prior.id) });
            }
            return res.status(409).json({ message: 'This payment is already linked to an order.' });
        }

        const data = readOrderPayload(req.body);
        data.fileCount = req.files.length;
        data.guestFullName = fullName;
        data.guestPhone = phone;
        data.guestClassroom = classroom;
        console.info('[ORDER_CREATE] Customer data validated:', {
            cashfreeOrderId,
            userIdPresent: Boolean(req.session?.userId),
            namePresent: Boolean(fullName),
            phonePresent: Boolean(phone),
            classroomPresent: Boolean(classroom)
        });
        console.info('[ORDER_CREATE] Files/documents validated:', {
            cashfreeOrderId,
            fileCount: req.files.length,
            fileSettingsCount: JSON.parse(req.body.fileSettings).length,
            totalFileBytes: req.files.reduce((total, file) => total + file.size, 0)
        });

        const pickupErr = slots.pickupError(data.collectionLocationId, data.collectionTime);
        if (pickupErr) return res.status(400).json({ message: pickupErr });

        // Re-derive the trusted amount from the actual uploaded files and confirm
        // the amount Cashfree collected matches it. The client-sent price is never trusted.
        let resolved;
        let expectedPrice;
        try {
            const priced = await resolveAndPriceFiles(req.files, req.body.fileSettings, {
                collectionLocationId: data.collectionLocationId,
                classroomDelivery: req.body.classroomDelivery
            });
            resolved = priced.resolved;
            expectedPrice = priced.amount;
        } catch (resolveErr) {
            return res.status(resolveErr.httpStatus || 400).json({ message: resolveErr.message, code: resolveErr.code || 'FILE_VALIDATION_FAILED' });
        }
        data.totalPrice = expectedPrice;
        data.fileCount = resolved.length;
        if (!cashfree.amountsMatch(cfOrder.order_amount, expectedPrice)) {
            return res.status(400).json({ message: 'Payment amount does not match the order requirements.' });
        }

        const userId = req.session?.userId || null;
        verificationStage = 'database_insert';
        console.info('[TICKET_CREATE] Database insert started:', { cashfreeOrderId });
        const order = await Order.createOrder(userId, DEFAULT_SHOP_ID, data);
        console.info('[TICKET_CREATE] Database insert completed:', {
            cashfreeOrderId,
            orderId: order.id
        });
        console.info('[TICKET_CREATE] Ticket/order ID generated:', {
            cashfreeOrderId,
            orderId: order.id,
            ticketNumberPresent: Boolean(order.ticketNumber)
        });

        verificationStage = 'ticket_file_persistence';
        await persistUploadedFiles(userId, order.id, resolved, stage => {
            verificationStage = stage;
        });
        const paymentId = cfOrder.cf_payment_id || cfOrder.order_id || cashfreeOrderId;
        verificationStage = 'payment_record_creation';
        console.info('[TICKET_CREATE] Payment record creation started:', {
            cashfreeOrderId,
            orderId: order.id
        });
        await Payment.createForOrder(
            order.id,
            userId,
            DEFAULT_SHOP_ID,
            Number(cfOrder.order_amount) || data.totalPrice || 0,
            'cashfree',
            String(paymentId),
            { status: 'success', gatewayOrderId: cashfreeOrderId }
        );

        console.info('[TICKET_CREATE] Payment record created:', {
            cashfreeOrderId,
            orderId: order.id,
            paymentStatus: 'success'
        });
        console.info('[TICKET_CREATE] Ticket created successfully:', {
            cashfreeOrderId,
            orderId: order.id,
            ticketNumberPresent: Boolean(order.ticketNumber)
        });
        res.status(201).json({ id: order.id, ticketNumber: order.ticketNumber, ticketToken: ticketToken.sign(order.id) });
    } catch (err) {
        if (err.code === '23505' && cashfreeOrderId) {
            try {
                const existing = await Payment.findByGatewayOrderId(cashfreeOrderId);
                if (existing?.order_id) {
                    const prior = await Order.getOrderById(existing.order_id);
                    if (prior) {
                        console.info('[TICKET_CREATE] Existing ticket returned after duplicate verification:', {
                            cashfreeOrderId,
                            orderId: prior.id
                        });
                        return res.status(200).json({ id: prior.id, ticketNumber: prior.ticket_number, ticketToken: ticketToken.sign(prior.id) });
                    }
                }
            } catch (recoveryError) {
                const recoverySafeError = safeOrderError(recoveryError);
                console.error('[TICKET_CREATE_FAILED]', {
                    stage: 'duplicate_recovery',
                    cashfreeOrderId,
                    error_code: recoverySafeError.code,
                    message: recoverySafeError.message
                });
            }
        }
        const safeError = safeOrderError(err);
        const diagnostic = {
            cashfreeOrderId: cashfreeOrderId || 'missing',
            stage: verificationStage,
            error_code: safeError.code,
            message: safeError.message
        });
        res.status(error.code === 'PAYMENT_ORDER_MISMATCH' ? 409 : 502).json({
            status: 'PAYMENT_PENDING',
            message: 'Payment confirmation is still pending. Please retry shortly.',
            code: error.code || 'PAYMENT_VERIFICATION_FAILED'
        });
    }
});

// POST /api/orders/payment/webhook — Cashfree server-to-server payment events.
router.post('/payment/webhook', async (req, res) => {
    if (!paymentGatewayReady()) {
        return res.status(503).json({ message: 'Payment gateway is not configured.' });
    }
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const rawBody = req.rawBody;
    if (!signature || !timestamp || typeof rawBody !== 'string') {
        return res.status(400).json({ message: 'Missing webhook signature.' });
    }

    const tsNum = Number(timestamp);
    if (Number.isFinite(tsNum)) {
        const ageMs = Math.abs(Date.now() - (String(timestamp).length <= 10 ? tsNum * 1000 : tsNum));
        if (ageMs > 15 * 60 * 1000) return res.status(400).json({ message: 'Stale webhook.' });
    }
    try {
        cashfree.verifyWebhookSignature(signature, rawBody, timestamp);
    } catch (error) {
        console.warn('[CASHFREE_WEBHOOK_REJECTED]', {
            code: String(error.code || 'INVALID_SIGNATURE').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)
        });
        return res.status(400).json({ message: 'Invalid webhook signature.' });
    }

    const orderId = req.body?.data?.order?.order_id;
    if (typeof orderId !== 'string' || !/^cp_[a-f0-9-]{36}$/i.test(orderId)) {
        return res.status(200).json({ ok: true, ignored: true });
    }

    try {
        const result = await reconcileCashfreePayment(orderId);
        const eventType = String(req.body?.type || req.body?.event || '').toUpperCase();
        const eventPaymentStatus = String(req.body?.data?.payment?.payment_status || '').toUpperCase();
        const indicatesSuccess = eventType.includes('SUCCESS') || eventPaymentStatus === 'SUCCESS';
        if (result.status === 'PAYMENT_PENDING' && indicatesSuccess) {
            return res.status(503).json({ message: 'Cashfree payment status is not yet final; retry webhook.' });
        }
        res.status(200).json({ ok: true, status: result.status });
    } catch (error) {
        const safeError = safeOrderError(error);
        console.error('[CASHFREE_WEBHOOK_RECONCILIATION_FAILED]', {
            cashfreeOrderId: orderId,
            code: safeError.code,
            message: safeError.message
        });
        res.status(503).json({ message: 'Payment status could not be reconciled; retry webhook.' });
    }
});


module.exports = router;
