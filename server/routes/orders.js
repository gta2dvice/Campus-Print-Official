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
const slots = require('../slots');
const pool = require('../db');
const { uploadBuffer, buildObjectPath, deleteFiles, downloadFile } = require('../storage');
const cashfree = require('../cashfree');
const { PRICING, priceOrder } = require('../pricing');
const { sendStoredFile } = require('../sendStoredFile');
const { createTicketToken, hashTicketToken, isValidTicketToken } = require('../ticketTokens');
const RecoveryOtp = require('../models/RecoveryOtp');
const otpService = require('../services/otp');
const { processSuccessfulPayment } = require('../services/paymentFinalizer');
const { tryEnsureTicket } = require('../services/ticketService');
const { sendTicketEmail, getTicketEmailStatus, retryTicketEmail } = require('../services/ticketEmailService');
const { logPaymentEvent } = require('../services/paymentLog');
const { normalizePhone, maskPhone } = require('../phone');
const { normalizeEmail, maskEmail, emailRateLimitKey } = require('../email');
const { rateLimit, phoneRateLimitKey } = require('../middleware/rateLimit');
const {
    establishRecoverySession,
    clearRecoverySession,
    requireRecoverySession,
    isAuthorizedForOrder
} = require('../middleware/recoveryAuth');


// Single-shop deployment today: new orders always go to shop id 1.
// (Shop selection would be added here if/when multiple shops go live.)
const DEFAULT_SHOP_ID = 1;

// ── Rate limiters for recovery / ticket / document endpoints ────────────────
const WINDOW_15_MIN = 15 * 60 * 1000;
const WINDOW_1_HOUR = 60 * 60 * 1000;
const lookupLimiter = rateLimit({
    prefix: 'rec-lookup',
    windowMs: WINDOW_15_MIN,
    max: 5,
    key: req => emailRateLimitKey(normalizeEmail(req.body?.email) || '')
});
const lookupHourlyLimiter = rateLimit({
    prefix: 'rec-lookup-hr',
    windowMs: WINDOW_1_HOUR,
    max: 10,
    key: req => emailRateLimitKey(normalizeEmail(req.body?.email) || '')
});
const verifyLimiter = rateLimit({
    prefix: 'rec-verify',
    windowMs: WINDOW_15_MIN,
    max: 10,
    key: req => emailRateLimitKey(normalizeEmail(req.body?.email) || '')
});
const historyLimiter = rateLimit({ prefix: 'rec-history', windowMs: WINDOW_15_MIN, max: 60 });
const ticketLimiter = rateLimit({ prefix: 'rec-ticket', windowMs: WINDOW_15_MIN, max: 120 });
const documentLimiter = rateLimit({ prefix: 'rec-doc', windowMs: WINDOW_15_MIN, max: 120 });
// Higher cap: the UPI QR screen and the Cashfree return page poll status every few seconds.
const pollLimiter = rateLimit({ prefix: 'poll-status', windowMs: WINDOW_15_MIN, max: 240 });

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

function safeRecoveryErrorCode(error) {
    return String(error?.code || 'RECOVERY_REQUEST_FAILED')
        .replace(/[^A-Za-z0-9_-]/g, '')
        .slice(0, 64) || 'RECOVERY_REQUEST_FAILED';
}

// ── Order / payment / ticket state (the one view every client screen reads) ──

/**
 * Authoritative state of an order for the student UI, derived from the DB only.
 *   paymentStatus: PAYMENT_PENDING | PAYMENT_PROCESSING | PAID | PAYMENT_FAILED | EXPIRED | REFUNDED
 *   ticketStatus:  PENDING_PAYMENT | GENERATION_PENDING | READY
 *   state:         one combined value — TICKET_READY / TICKET_GENERATION_PENDING once paid,
 *                  otherwise the paymentStatus.
 */
function orderState(order, latestPayment, { processing = false } = {}) {
    let paymentStatus = order.payment_status || 'PAYMENT_PENDING';
    if (latestPayment && latestPayment.status === 'refunded') {
        paymentStatus = 'REFUNDED';
    } else if (paymentStatus === 'PAYMENT_PENDING') {
        // A still-pending UPI QR whose QR window lapsed is EXPIRED (the order stays
        // payable via a refreshed QR; the DB row stays 'pending').
        if (processing) {
            paymentStatus = 'PAYMENT_PROCESSING';
        }
    }
    const ticketStatus = order.ticket_status || (paymentStatus === 'PAID' ? 'GENERATION_PENDING' : 'PENDING_PAYMENT');
    let state = paymentStatus;
    if (paymentStatus === 'PAID') {
        state = ticketStatus === 'READY' ? 'TICKET_READY' : 'TICKET_GENERATION_PENDING';
    }
    return { paymentStatus, ticketStatus, state };
}

// Safe, recovery-facing view of an order. No credentials, no internal-only fields,
// no raw files. Phone is intentionally omitted (masked where needed).
function toRecoveryOrderSummary(order) {
    const latestPayment = order.latest_payment_status
        ? { status: order.latest_payment_status, method: order.latest_payment_method, qr_expires_at: order.latest_qr_expires_at }
        : null;
    const { paymentStatus, ticketStatus, state } = orderState(order, latestPayment);
    return {
        orderId: order.id,
        orderReference: `#${order.id}`,
        ticketId: ticketStatus === 'READY' ? order.ticket_number : null,
        paymentMethod: order.payment_method || order.latest_payment_method || null,
        paymentStatus,
        ticketStatus,
        state,
        orderStatus: String(order.status || '').toUpperCase(),
        collectionLocation: order.collection_location || null,
        collectionTime: order.collection_time || null,
        collectionDate: order.collection_date || null,
        amount: Number(order.total_price) || 0,
        fileCount: order.file_count || 0,
        createdAt: order.created_at,
        // Lets an unpaid Cashfree order be paid again (same order) from the booking page.
        cashfreeOrderId: order.payment_method === 'CASHFREE' && paymentStatus !== 'PAID'
            ? order.latest_gateway_order_id || null
            : null
    };
}

/** Ticket page payload: the order + its state; recovers a pending ticket on read. */
async function buildTicketView(order) {
    if (order.payment_status === 'PAYMENT_PENDING' && order.payment_method === 'CASHFREE' && paymentGatewayReady()) {
        const attempt = await Order.getLatestCashfreeAttempt(order.id);
        if (attempt && attempt.status === 'pending') {
            try { await reconcileCashfreePayment(attempt.gateway_order_id, 'ticket_view'); } catch {}
            order = await Order.getOrderRecord(order.id);
        }
    }
    if (order.payment_status === 'PAID' && order.ticket_status !== 'READY') {
        await tryEnsureTicket(order.id);
        order = await Order.getOrderRecord(order.id);
        if (order?.ticket_status === 'READY') {
            try { await sendTicketEmail(order.id, { source: 'ticket_view' }); } catch {}
        }
    }
    // Prefer the successful attempt; otherwise the latest one.
    const [[payment]] = await pool.query(
        `SELECT method, status, amount, transaction_ref, qr_expires_at FROM payments
         WHERE order_id = ? ORDER BY (status = 'success') DESC, id DESC LIMIT 1`,
        [order.id]
    );
    const view = { ...order };
    delete view.ticket_access_token_hash;
    const state = orderState(order, payment);
    const emailDelivery = await getTicketEmailStatus(order.id).catch(() => null);
    return {
        ...view,
        // Never ship the full phone number to the client; the ticket shows a mask.
        guest_phone: maskPhone(order.guest_phone),
        ticket_number: state.ticketStatus === 'READY' ? order.ticket_number : null,
        payment: payment ? {
            method: payment.method,
            status: payment.status,
            amount: Number(payment.amount),
            transaction_ref: payment.status === 'success' ? payment.transaction_ref : null
        } : null,
        emailDelivery,
        ...state
    };
}

// ── Order Configuration ─────────────────────
// Rates + the printing / extra-charge split live in server/pricing.js.

// Upper bound on a user-declared page count (only used when the server can't count
// a file's pages) so a tampered value can't produce an absurd charge.
const MAX_DECLARED_PAGES = 2000;

/**
 * The single source of truth for amount + per-file data. Validates each uploaded
 * file's type (extension + magic bytes), derives the page count from the actual
 * bytes where reliable, and — only for types with no reliable server-side count —
 * falls back to the user-declared count (clamped), which the shop confirms at
 * processing. The frontend NEVER dictates the amount.
 *
 * Throws an Error with .code / .httpStatus for an invalid upload.
 * Returns { resolved, amount, charges } — charges is pricing.priceOrder()'s split;
 * each resolved file also carries its own printingCharge.
 */
async function resolveAndPriceFiles(files, fileSettingsRaw, { collectionLocationId, classroomDelivery, binding }) {
    if (!files || files.length === 0) {
        const e = new Error('Please upload at least one file to continue.');
        e.code = 'NO_FILES'; e.httpStatus = 400; throw e;
    }
    let settings;
    try {
        settings = fileSettingsRaw
            ? (typeof fileSettingsRaw === 'string' ? JSON.parse(fileSettingsRaw) : fileSettingsRaw)
            : [];
    } catch {
        settings = null;
    }
    if (!Array.isArray(settings) || settings.length !== files.length) {
        const e = new Error('Every uploaded file must have printing settings.');
        e.code = 'FILE_SETTINGS_INVALID'; e.httpStatus = 400; throw e;
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
        if (!det.estimated && det.pages >= 1) {
            // Reliable server-side count — ignore any client-sent page value.
            pages = det.pages;
        } else {
            const declared = parseInt(setting.pages, 10);
            pages = Math.max(1, Math.min(MAX_DECLARED_PAGES, Number.isFinite(declared) ? declared : 1));
        }

        // Optional PDF page range (e.g. "33-55"). It is validated against the REAL
        // page count, then drives both the price and the printable page count, so the
        // printer only ever receives the selected pages (see sendStoredFile.js).
        const rawRange = typeof setting.pageRange === 'string' ? setting.pageRange.trim() : '';
        let pageRange = null;
        if (rawRange) {
            const rangeError = (message, code = 'PAGE_RANGE_INVALID') => {
                const e = new Error(message);
                e.code = code; e.httpStatus = 400; return e;
            };
            if (type.key !== 'pdf') {
                throw rangeError('A page range is only supported for PDF files.', 'PAGE_RANGE_UNSUPPORTED');
            }
            const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(rawRange);
            if (!match) {
                throw rangeError('Use a page range like 1-5 or single page like 5.');
            }
            const start = parseInt(match[1], 10);
            const end = match[2] !== undefined ? parseInt(match[2], 10) : start;
            if (start < 1) throw rangeError('Pages start at 1 — the page range cannot start at 0.');
            if (start > end) throw rangeError('The start page must be less than or equal to the end page.');
            if (end > pages) throw rangeError(`The page range must be within 1-${pages} pages for this file.`);
            pageRange = `${start}-${end}`;
            pages = end - start + 1; // printable pages: price + stored page_count use the range
        }

        resolved.push({
            file,
            originalname: file.originalname,
            mimetype: type.mime,
            size: file.size,
            fileType: type.label,
            pages,
            pageRange,
            copies: Math.max(1, parseInt(setting.copies, 10) || 1),
            printingSide: setting.printingSide === 'double' ? 'double' : 'single',
            colorMode: setting.colorMode === 'color' ? 'color' : 'bw',
            ...(Object.prototype.hasOwnProperty.call(setting, 'spiralBinding')
                ? { spiralBinding: setting.spiralBinding === true || setting.spiralBinding === 'true' }
                : {})
        });
    }

    const charges = priceOrder(resolved, { collectionLocationId, classroomDelivery, binding });
    resolved.forEach((f, i) => { f.printingCharge = charges.fileCharges[i]; });
    return { resolved, amount: charges.total, charges };
}

function readOrderPayload(body) {
    return {
        colorOption: body.colorOption,
        paperSize: body.paperSize,
        copies: Number(body.copies),
        spiralBinding: body.spiralBinding === 'true' || body.spiralBinding === true,
        expressDelivery: body.expressDelivery === 'true' || body.expressDelivery === true,
        totalPages: Number(body.totalPages) || 0,
        collectionLocationId: body.collectionLocationId || null,
        collectionLocationName: body.collectionLocation || null,
        collectionTime: body.collectionTime || null,
        // Derived from the server's own clock, not trusted from the client, so a pre-order
        // placed after 5 PM IST is always correctly recorded against tomorrow's date.
        collectionDate: slots.getOrderDateContext().date
    };
}

/**
 * Shared validation for every order submission (files + customer fields + pickup),
 * whatever the payment method. Returns { data, resolved, amount } or sends an
 * error response and returns null. The amount is computed server-side only.
 */
async function validateAndPriceSubmission(req, res) {
    if (!req.files || req.files.length === 0) {
        res.status(400).json({ message: 'Please upload at least one file to continue.' });
        return null;
    }
    if (!req.body.fileSettings) {
        res.status(400).json({ message: 'Please configure printing settings for all files.' });
        return null;
    }
    const { fullName, phone, email, guestEmail, classroom, batch, classSection } = req.body;
    if (!fullName || !phone || !classroom || !classroom.trim()) {
        res.status(400).json({ message: 'Full Name, Phone, and Classroom/Room Number are required.' });
        return null;
    }
    const rawEmail = String(email || guestEmail || '').trim();
    const normalizedEmail = normalizeEmail(rawEmail);
    if (!rawEmail) {
        res.status(400).json({ message: 'Email address is required.', code: 'EMAIL_REQUIRED' });
        return null;
    }
    if (!normalizedEmail) {
        res.status(400).json({
            message: 'Enter a valid email address for order notifications and recovery.',
            code: 'EMAIL_INVALID'
        });
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
    if (data.paperSize && data.paperSize !== 'A4') {
        res.status(400).json({ message: 'Only A4 paper size is currently supported.' });
        return null;
    }
    data.paperSize = 'A4';
    const pickupErr = slots.pickupError(data.collectionLocationId, data.collectionTime);
    if (pickupErr) { res.status(400).json({ message: pickupErr }); return null; }

    let resolved;
    let amount;
    try {
        const priced = await resolveAndPriceFiles(req.files, req.body.fileSettings, {
            collectionLocationId: data.collectionLocationId,
            classroomDelivery: req.body.classroomDelivery,
            // Preserve compatibility with old clients; per-file settings are canonical.
            binding: data.spiralBinding
        });
        resolved = priced.resolved;
        amount = priced.amount;
        data.charges = priced.charges;
        data.spiralBinding = priced.charges.bindingCharge > 0;
    } catch (e) {
        res.status(e.httpStatus || 400).json({ message: e.message, code: e.code || 'FILE_VALIDATION_FAILED' });
        return null;
    }
    if (!amount || amount <= 0) { res.status(400).json({ message: 'Invalid order amount' }); return null; }

    data.totalPrice = amount;
    data.fileCount = resolved.length;
    data.guestFullName = fullName;
    data.guestEmail = normalizedEmail || null;
    data.guestPhone = phone;
    data.guestClassroom = classroom;
    return { data, resolved, amount };
}

// Persists the SERVER-RESOLVED files under the order. If any upload fails the
// already-uploaded objects are removed and the error is rethrown.
async function persistUploadedFiles(userId, orderId, resolvedFiles) {
    const stored = [];
    try {
        for (const [index, rf] of resolvedFiles.entries()) {
            const { storedName, storagePath } = buildObjectPath(userId || 'guest', orderId, rf.originalname);
            await uploadBuffer({ storagePath, buffer: rf.file.buffer, contentType: rf.mimetype });
            stored.push({
                originalname: rf.originalname,
                storedName,
                storagePath,
                mimetype: rf.mimetype,
                size: rf.size,
                fileType: rf.fileType,
                pageCount: rf.pages,
                pageRange: rf.pageRange || null,
                printingSide: rf.printingSide,
                copies: rf.copies,
                colorMode: rf.colorMode,
                printingCharge: rf.printingCharge,
                spiralBinding: rf.spiralBinding
            });
            console.info('[ORDER_CREATE] File storage upload completed:', {
                orderId,
                fileIndex: index + 1,
                fileCount: resolvedFiles.length
            });
        }
        await OrderFile.createFiles(orderId, stored);
    } catch (error) {
        const paths = stored.map(file => file.storagePath);
        if (paths.length) {
            try {
                await deleteFiles(paths);
            } catch (cleanupError) {
                console.error('[ORDER_FILE_CLEANUP_FAILED]', {
                    orderId,
                    fileCount: paths.length,
                    message: safeOrderError(cleanupError).message
                });
            }
        }
        throw error;
    }
}

/**
 * Creates the canonical order + first payment attempt, then attaches its files.
 * If the files can't be stored, the attempt is marked failed so the order never
 * looks payable without its files. Returns { id, paymentId, paymentReference }.
 */
async function createOrderWithFiles(req, { data, resolved, payment, ticketTokenHash }) {
    const userId = req.session?.userId || null;
    const order = await Order.createOrder(userId, DEFAULT_SHOP_ID, data, { payment, ticketTokenHash });
    logPaymentEvent('ORDER_CREATED', { orderId: order.id, method: payment.method, amount: data.totalPrice });
    try {
        await persistUploadedFiles(userId, order.id, resolved);
    } catch (error) {
        await Order.failPaymentAttempt(order.paymentId);
        logPaymentEvent('PAYMENT_FAILED', { orderId: order.id, paymentId: order.paymentId, reason: 'FILE_STORAGE_FAILED' });
        throw error;
    }
    return order;
}

// @route  GET /api/orders/config
router.get('/config', (req, res) => {
    res.json({
        pricing: PRICING,
        locations: slots.LOCATIONS
    });
});

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
            hasQr: Boolean(shop?.payment_qr_path),
            // Path changes on every upload, so it doubles as a cache-buster for the image URL.
            qrVersion: shop?.payment_qr_path
                ? encodeURIComponent(shop.payment_qr_path.split('/').pop())
                : null
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

// ── Guest order recovery (email → OTP → recovery session) ───────────────────
// Declared before GET '/:id' so '/lookup', '/verify-recovery', '/history' and
// '/logout-recovery' are never swallowed by the ':id' route.

// POST /api/orders/lookup — start recovery: validate email, issue an OTP via Resend.
// Always responds generically; it never reveals whether orders exist for an email.
router.post('/lookup', lookupHourlyLimiter, lookupLimiter, async (req, res) => {
    const rawEmail = req.body?.email;
    const email = normalizeEmail(rawEmail);
    if (!email) {
        return res.status(400).json({ message: 'Enter a valid email address.', code: 'INVALID_EMAIL' });
    }

    const cooldown = await RecoveryOtp.checkCooldown(email);
    if (cooldown.inCooldown) {
        return res.status(429).json({
            message: `Please wait ${cooldown.remainingSeconds}s before requesting a new code.`,
            code: 'RESEND_COOLDOWN',
            retryAfter: cooldown.remainingSeconds
        });
    }

    let record;
    try {
        record = await RecoveryOtp.createOtp(email);
    } catch (error) {
        console.error('[RECOVERY_LOOKUP_FAILED]', {
            stage: 'otp_persistence',
            code: safeRecoveryErrorCode(error)
        });
        return res.status(500).json({
            message: 'We could not start order verification. Please try again.',
            code: 'RECOVERY_STORAGE_FAILED'
        });
    }

    try {
        const delivery = await otpService.sendOtp(email, record.otp);
        if (!delivery?.delivered) {
            const error = new Error('The email service did not confirm delivery.');
            error.code = 'OTP_PROVIDER_UNCONFIRMED';
            error.status = 503;
            throw error;
        }
        console.info('[RECOVERY_OTP_DELIVERY_SUCCEEDED]', {
            provider: delivery.provider || 'development'
        });
        try {
            await RecoveryOtp.cleanupExpired();
        } catch (cleanupError) {
            console.warn('[RECOVERY_OTP_CLEANUP_FAILED]', {
                stage: 'expired_code_cleanup',
                code: safeRecoveryErrorCode(cleanupError)
            });
        }
        return res.json({
            message: 'If this address is eligible, you will receive a verification code.',
            emailMasked: maskEmail(email),
            cooldownSeconds: 60,
            ...(delivery.devOtp ? {
                devOtp: delivery.devOtp,
                devNote: 'Development-only code for local testing.'
            } : {})
        });
    } catch (error) {
        try {
            await RecoveryOtp.invalidateOtp(record.id);
        } catch (invalidateError) {
            console.error('[RECOVERY_OTP_INVALIDATION_FAILED]', {
                stage: 'failed_delivery_cleanup',
                code: safeRecoveryErrorCode(invalidateError)
            });
        }

        const status = [429, 502, 503].includes(error.status) ? error.status : 503;
        const code = safeRecoveryErrorCode(error);
        console.warn('[RECOVERY_OTP_DELIVERY_FAILED]', {
            stage: 'email_delivery',
            code,
            status
        });
        return res.status(status).json({
            message: error.message || 'We could not send a verification code. Please try again later.',
            code
        });
    }
});

// POST /api/orders/verify-recovery — verify OTP, open a short-lived recovery session.
router.post('/verify-recovery', verifyLimiter, async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const otp = String(req.body?.otp || '').trim();
        if (!email) {
            return res.status(400).json({ message: 'Enter a valid email address.', code: 'INVALID_EMAIL' });
        }
        if (!/^[0-9]{6}$/.test(otp)) {
            return res.status(400).json({ message: 'Enter the 6-digit verification code.', code: 'INVALID_OTP' });
        }

        const result = await RecoveryOtp.verifyOtp(email, otp);
        if (!result.ok) {
            if (result.reason === 'locked') {
                return res.status(429).json({
                    message: 'Too many incorrect attempts. Request a new code.',
                    code: 'OTP_ATTEMPTS_EXCEEDED'
                });
            }
            if (result.reason === 'expired') {
                return res.status(400).json({
                    message: 'Your code has expired. Request a new code.',
                    code: 'OTP_EXPIRED'
                });
            }
            return res.status(400).json({
                message: 'That code is invalid. Please try again.',
                code: 'OTP_VERIFICATION_FAILED',
                attemptsLeft: result.attemptsLeft
            });
        }

        establishRecoverySession(req, email);
        return res.json({ verified: true, emailMasked: maskEmail(email) });
    } catch (error) {
        console.error('[RECOVERY_VERIFY_FAILED]', {
            stage: 'otp_verification',
            code: safeRecoveryErrorCode(error)
        });
        return res.status(500).json({
            message: 'We could not verify that code right now. Please try again.',
            code: 'RECOVERY_VERIFY_FAILED'
        });
    }
});

// GET /api/orders/history — every order (Cashfree, UPI QR, …) for the verified
// recovery session's email, from the database.
router.get('/history', historyLimiter, requireRecoverySession, async (req, res) => {
    try {
        const orders = await Order.getOrdersByVerifiedEmail(req.recoveryEmail);
        return res.json({
            emailMasked: maskEmail(req.recoveryEmail),
            orders: orders.map(toRecoveryOrderSummary)
        });
    } catch (error) {
        console.error('[RECOVERY_HISTORY_FAILED]', {
            stage: 'order_history_query',
            code: safeRecoveryErrorCode(error)
        });
        return res.status(500).json({
            message: 'We could not load your orders right now. Please try again.',
            code: 'RECOVERY_HISTORY_FAILED'
        });
    }
});

// POST /api/orders/logout-recovery — end the recovery session.
router.post('/logout-recovery', (req, res) => {
    clearRecoverySession(req);
    return res.json({ success: true, message: 'Recovery session ended.' });
});

// GET /api/orders/ticket/:token — ticket link (bearer token; only its hash is stored).
router.get('/ticket/:token', ticketLimiter, async (req, res) => {
    try {
        const token = req.params.token;
        const order = await Order.getOrderByTicketTokenHash(hashTicketToken(token));
        if (!order || !isValidTicketToken(token, order.ticket_access_token_hash)) {
            return res.status(404).json({ message: 'Ticket not found.', code: 'TICKET_NOT_FOUND' });
        }
        res.json(await buildTicketView(await Order.getOrderRecord(order.id)));
    } catch (error) {
        const safeError = safeOrderError(error);
        console.error('[TICKET_LOAD_FAILED]', {
            stage: 'secure_ticket_lookup',
            code: safeError.code,
            message: safeError.message
        });
        res.status(500).json({ message: 'Unable to load this ticket right now. Please retry.', code: 'TICKET_LOAD_FAILED' });
    }
});

// POST /api/orders/ticket/:token/retry-email — controlled email retry via valid ticket token.
router.post('/ticket/:token/retry-email', ticketLimiter, async (req, res) => {
    try {
        const token = req.params.token;
        const order = await Order.getOrderByTicketTokenHash(hashTicketToken(token));
        if (!order || !isValidTicketToken(token, order.ticket_access_token_hash)) {
            return res.status(404).json({ message: 'Ticket not found.', code: 'TICKET_NOT_FOUND' });
        }
        if (order.payment_status !== 'PAID' || order.ticket_status !== 'READY') {
            return res.status(400).json({ message: 'This order is not ready for ticket delivery.', code: 'ORDER_NOT_READY' });
        }
        const result = await retryTicketEmail(order.id);
        const emailStatus = await getTicketEmailStatus(order.id);
        return res.json({
            success: result.status === 'SENT',
            emailDelivery: emailStatus,
            message: result.status === 'SENT' ? 'Ticket email delivered successfully.' : 'Email delivery failed; please retry later.'
        });
    } catch (err) {
        console.error('[RETRY_EMAIL_FAILED]', safeOrderError(err).message);
        return res.status(500).json({ message: 'Could not retry sending email.', code: 'RETRY_EMAIL_FAILED' });
    }
});

// GET /api/orders/:id — single order ticket. Requires a recovery session (matching
// guest_phone), this order's ticket token, or account ownership. A bare id is never enough.
router.get('/:id', ticketLimiter, async (req, res) => {
    try {
        const order = await Order.getOrderRecord(req.params.id);
        if (!order || !isAuthorizedForOrder(req, order)) {
            // Same response for "missing" and "not yours" so ids can't be probed.
            return res.status(404).json({
                message: 'This ticket link is no longer valid. Recover your order from the Orders page.',
                code: 'ORDER_NOT_FOUND'
            });
        }
        res.json(await buildTicketView(order));
    } catch (err) {
        const safeError = safeOrderError(err);
        console.error('[TICKET_LOAD_FAILED]', { orderId: req.params.id, code: safeError.code, message: safeError.message });
        res.status(500).json({ message: 'Unable to load this ticket right now. Please retry.', code: 'TICKET_LOAD_FAILED' });
    }
});

// POST /api/orders/:id/retry-email — retry sending ticket email for authenticated order.
router.post('/:id/retry-email', ticketLimiter, async (req, res) => {
    try {
        const order = await Order.getOrderRecord(req.params.id);
        if (!order || !isAuthorizedForOrder(req, order)) {
            return res.status(404).json({ message: 'Order not found.', code: 'ORDER_NOT_FOUND' });
        }
        if (order.payment_status !== 'PAID' || order.ticket_status !== 'READY') {
            return res.status(400).json({ message: 'This order is not ready for ticket delivery.', code: 'ORDER_NOT_READY' });
        }
        const result = await retryTicketEmail(order.id);
        const emailStatus = await getTicketEmailStatus(order.id);
        return res.json({
            success: result.status === 'SENT',
            emailDelivery: emailStatus,
            message: result.status === 'SENT' ? 'Ticket email delivered successfully.' : 'Email delivery failed; please retry later.'
        });
    } catch (err) {
        console.error('[RETRY_EMAIL_FAILED]', safeOrderError(err).message);
        return res.status(500).json({ message: 'Could not retry sending email.', code: 'RETRY_EMAIL_FAILED' });
    }
});

// GET /api/orders/:id/payment-status — authoritative payment + ticket state from the
// DB. For a pending Cashfree order it re-verifies with Cashfree (read-only lookup;
// finalizes through the shared finalizer if paid); for a paid order still waiting
// on its ticket it retries ticket issuing. Never trusts the client.
router.get('/:id/payment-status', pollLimiter, async (req, res) => {
    try {
        let order = await Order.getOrderRecord(req.params.id);
        if (!order || !isAuthorizedForOrder(req, order)) {
            return res.status(404).json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
        }

        let processing = false;
        if (order.payment_status === 'PAYMENT_PENDING' && order.payment_method === 'CASHFREE' && paymentGatewayReady()) {
            const attempt = await Order.getLatestCashfreeAttempt(order.id);
            if (attempt && attempt.status === 'pending') {
                try {
                    const result = await reconcileCashfreePayment(attempt.gateway_order_id, 'status_poll');
                    processing = result.status === 'PAYMENT_PROCESSING';
                } catch (reconcileErr) {
                    // Non-fatal: fall back to the stored status. Never mark failed from here.
                    console.warn('[PAYMENT_STATUS_RECONCILE]', safeOrderError(reconcileErr).message);
                }
            }
        } else if (order.payment_status === 'PAID' && order.ticket_status !== 'READY') {
            await tryEnsureTicket(order.id);
            const updated = await Order.getOrderRecord(order.id);
            if (updated?.ticket_status === 'READY') {
                try { await sendTicketEmail(order.id, { source: 'payment_status_poll' }); } catch {}
            }
        }
        order = await Order.getOrderRecord(order.id);

        const payment = await Payment.findByOrderId(order.id);
        const state = orderState(order, payment, { processing });
        const emailDelivery = await getTicketEmailStatus(order.id).catch(() => null);
        return res.json({
            orderId: order.id,
            orderReference: `#${order.id}`,
            ticketId: state.ticketStatus === 'READY' ? order.ticket_number : null,
            paymentMethod: order.payment_method,
            paymentReference: payment?.payment_reference || null,
            emailDelivery,
            ...state
        });
    } catch (err) {
        console.error('[PAYMENT_STATUS_FAILED]', safeOrderError(err).message);
        return res.status(500).json({ message: 'Unable to check payment status right now. Please retry.' });
    }
});

// GET /api/orders/:id/documents — authorized document list (metadata only, no binaries).
router.get('/:id/documents', documentLimiter, async (req, res) => {
    try {
        const order = await Order.getOrderRecord(req.params.id);
        if (!order || !isAuthorizedForOrder(req, order)) {
            return res.status(404).json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
        }

        const files = await OrderFile.getFilesByOrder(order.id);
        const documents = files.map(f => ({
            fileId: f.id,
            name: f.original_name,
            sizeBytes: f.size_bytes,
            pageRange: f.page_range || null,
            // Uploaded files are purged after 24h; surface that instead of a dead link.
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
        const order = await Order.getOrderRecord(req.params.id);
        if (!order || !isAuthorizedForOrder(req, order)) {
            return res.status(404).json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
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
            // For estimated types the UI shows an editable page-count field.
            return { name: f.originalname, fileType: type.label, mimeType: type.mime, pages, estimated };
        }));
        res.json({ files: results });
    } catch (err) {
        console.error('Detect pages error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// GET /api/orders — logged-in student's paid orders.
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

// ── Cashfree ─────────────────────────────────────────────────────────────────

const CASHFREE_ORDER_ID_PATTERN = /^cp_[a-f0-9-]{36}$/i;

function newCashfreeOrderId() {
    return `cp_${crypto.randomUUID()}`;
}

/** Return / webhook URLs for a Cashfree checkout. Throws a 503-coded error if misconfigured. */
function cashfreeUrls(req) {
    const requestOrigin = req.get('origin') || '';
    const localFrontendOrigin = /^http:\/\/localhost(?::\d+)?$/.test(requestOrigin) ? requestOrigin : '';
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
        // Reported below in production.
    }
    if (process.env.NODE_ENV === 'production' && !webhookOrigin) {
        const error = new Error('Cashfree payments require PUBLIC_API_URL to be a public HTTPS API origin.');
        error.code = 'PAYMENT_WEBHOOK_URL_REQUIRED';
        error.response = { status: 503 };
        throw error;
    }
    return {
        // The return URL only brings the student back; it is never proof of payment.
        returnUrl: `${frontend}/new-order?cf_order={order_id}`,
        notifyUrl: webhookOrigin ? `${webhookOrigin}/api/orders/payment/webhook` : undefined
    };
}

/** Opens a Cashfree checkout for one attempt and checks the response matches it. */
async function openCashfreeCheckout(req, { cashfreeOrderId, amount, phone, email }) {
    const userId = req.session?.userId || null;
    const User = require('../models/User');
    const user = userId ? await User.findById(userId) : null;
    const { returnUrl, notifyUrl } = cashfreeUrls(req);

    const customerEmail = user?.email || normalizeEmail(email) || `${phone}@guest.campusprint.com`;
    const session = await cashfree.createPaymentSession({
        orderId: cashfreeOrderId,
        amount,
        customerId: `cust_${userId || 'guest'}_${Date.now()}`,
        customerEmail,
        customerPhone: phone,
        returnUrl,
        notifyUrl
    });
    if (!session.paymentSessionId || session.cashfreeOrderId !== cashfreeOrderId ||
        !cashfree.amountsMatch(session.orderAmount, amount)) {
        const error = new Error('Cashfree did not return a valid payment session for this order.');
        error.code = session.paymentSessionId ? 'CASHFREE_ORDER_MISMATCH' : 'PAYMENT_SESSION_MISSING';
        error.response = { status: 502 };
        throw error;
    }
    return session;
}

/**
 * Ticket link token for a Cashfree order: derived from its latest attempt (whose
 * hash is stored on the order). Returns null if it doesn't match the stored hash.
 */
async function cashfreeTicketToken(orderId) {
    const [order, attempt] = await Promise.all([Order.getOrderRecord(orderId), Order.getLatestCashfreeAttempt(orderId)]);
    if (!order || !attempt) return null;
    const token = createTicketToken(attempt.gateway_order_id);
    return isValidTicketToken(token, order.ticket_access_token_hash) ? token : null;
}

async function paidResult(orderId, ticket) {
    const emailDelivery = ticket.emailDelivery || (await getTicketEmailStatus(orderId).catch(() => null));
    return {
        status: 'PAID',
        id: orderId,
        ticketNumber: ticket.ticketNumber,
        ticketStatus: ticket.ticketStatus,
        ticketToken: await cashfreeTicketToken(orderId),
        emailDelivery
    };
}

/**
 * Re-verifies one Cashfree attempt with Cashfree (never trusting the client or the
 * return URL) and, if captured, settles it through the shared finalizer.
 * Returns { status: PAID | PAYMENT_PENDING | PAYMENT_PROCESSING | PAYMENT_FAILED | NOT_FOUND, ... }.
 */
async function reconcileCashfreePayment(cashfreeOrderId, source) {
    const intent = await Order.getPaymentIntentByGatewayOrderId(cashfreeOrderId);
    if (!intent) return { status: 'NOT_FOUND' };
    if (intent.order_payment_status === 'PAID') {
        // Already finalized (by this or another attempt) — return it; recover a pending ticket.
        return paidResult(intent.order_id, await tryEnsureTicket(intent.order_id));
    }
    if (intent.payment_status !== 'pending') {
        return { status: 'PAYMENT_FAILED', id: intent.order_id, canRetry: true };
    }

    const shouldRetry = source === 'return_verify' || source === 'cashfree_webhook';
    const providerOrder = shouldRetry
        ? await cashfree.fetchOrderUntilPaid(cashfreeOrderId)
        : await cashfree.fetchOrder(cashfreeOrderId);
    const providerPayments = await cashfree.fetchOrderPayments(cashfreeOrderId);
    if (providerOrder.order_id !== cashfreeOrderId ||
        !cashfree.amountsMatch(providerOrder.order_amount, intent.payment_amount) ||
        String(providerOrder.order_currency || '').toUpperCase() !== 'INR') {
        logPaymentEvent('PAYMENT_REJECTED', { orderId: intent.order_id, cashfreeOrderId, reason: 'CASHFREE_ORDER_MISMATCH', source });
        const error = new Error('Cashfree order identity, currency, or amount did not match the persisted order.');
        error.code = 'PAYMENT_ORDER_MISMATCH';
        throw error;
    }

    const successfulPayments = providerPayments.filter(cashfree.isPaymentPaid);
    const successfulPayment = successfulPayments.find(payment =>
        cashfree.amountsMatch(payment.payment_amount, intent.payment_amount) &&
        (!payment.order_id || payment.order_id === cashfreeOrderId)
    );
    if (cashfree.isOrderPaid(providerOrder) && successfulPayments.length && !successfulPayment) {
        logPaymentEvent('PAYMENT_REJECTED', { orderId: intent.order_id, cashfreeOrderId, reason: 'CAPTURED_AMOUNT_MISMATCH', source });
        const error = new Error('Cashfree captured payment did not match the persisted order amount.');
        error.code = 'PAYMENT_ORDER_MISMATCH';
        throw error;
    }
    if (cashfree.isOrderPaid(providerOrder) && successfulPayment) {
        const result = await processSuccessfulPayment(intent.order_id, {
            paymentId: intent.payment_id,
            method: 'cashfree',
            amount: successfulPayment.payment_amount,
            currency: successfulPayment.payment_currency || providerOrder.order_currency,
            transactionRef: successfulPayment.cf_payment_id ? String(successfulPayment.cf_payment_id) : null,
            source
        });
        return paidResult(intent.order_id, result);
    }

    const orderStatus = String(providerOrder.order_status || '').toUpperCase();
    if (orderStatus === 'EXPIRED' || orderStatus === 'TERMINATED' ||
        cashfree.arePaymentsFinalizedAsFailed(providerPayments)) {
        await Order.failPayment(cashfreeOrderId);
        logPaymentEvent('PAYMENT_FAILED', { orderId: intent.order_id, cashfreeOrderId, providerStatus: orderStatus, source });
        return { status: 'PAYMENT_FAILED', id: intent.order_id, canRetry: true };
    }
    const processing = providerPayments.some(p => String(p.payment_status || '').toUpperCase() === 'PENDING');
    return {
        status: processing ? 'PAYMENT_PROCESSING' : 'PAYMENT_PENDING',
        id: intent.order_id,
        paymentSessionId: providerOrder.payment_session_id || null
    };
}

// POST /api/orders/payment/create — creates the canonical order (PAYMENT_PENDING) and
// its files FIRST, then opens a Cashfree checkout for it. If the browser never comes
// back, the webhook (or a later status check) still finalizes this same order.
router.post('/payment/create', upload.array('files', 10), async (req, res) => {
    if (!paymentGatewayReady()) {
        console.error('[PAYMENT_CREATE_FAILED]', { stage: 'gateway_configuration', code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' });
        return res.status(503).json({ message: 'Payment gateway is not configured on the server.', code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' });
    }

    let stage = 'request_validation';
    let cashfreeOrderId = null;
    let orderId = null;
    try {
        const validated = await validateAndPriceSubmission(req, res);
        if (!validated) return undefined; // response already sent
        const { data, resolved, amount } = validated;
        cashfreeUrls(req); // fail fast on a production misconfiguration, before creating anything

        stage = 'order_persistence';
        cashfreeOrderId = newCashfreeOrderId();
        const order = await createOrderWithFiles(req, {
            data,
            resolved,
            payment: { method: 'cashfree', gatewayOrderId: cashfreeOrderId },
            ticketTokenHash: hashTicketToken(createTicketToken(cashfreeOrderId))
        });
        orderId = order.id;

        stage = 'cashfree_order_create';
        const session = await openCashfreeCheckout(req, {
            cashfreeOrderId,
            amount,
            phone: req.body.phone,
            email: data.guestEmail
        });
        logPaymentEvent('PAYMENT_INITIATED', { orderId, paymentId: order.paymentId, method: 'cashfree', cashfreeOrderId, amount });
        res.json({
            orderId,
            paymentSessionId: session.paymentSessionId,
            cashfreeOrderId,
            mode: cashfree.getMode()
        });
    } catch (err) {
        if (orderId && cashfreeOrderId && stage === 'cashfree_order_create') {
            // The checkout never opened: close this attempt so the order can be retried.
            await Order.failPayment(cashfreeOrderId).catch(() => {});
            logPaymentEvent('PAYMENT_FAILED', { orderId, cashfreeOrderId, reason: 'CHECKOUT_CREATE_FAILED' });
        }
        const details = paymentCreateErrorDetails(err);
        console.error('[PAYMENT_CREATE_FAILED]', { stage, status: details.status, code: details.code, message: details.message });
        res.status(details.status && details.status >= 400 && details.status < 600 ? details.status : 503).json({
            message: details.message,
            code: details.code
        });
    }
});

// POST /api/orders/payment/cashfree/retry — pay again for the SAME order after a failed
// or abandoned checkout. Authorized by the previous attempt's Cashfree order id (an
// unguessable UUID the student's browser received). Never creates a second order.
router.post('/payment/cashfree/retry', pollLimiter, async (req, res) => {
    if (!paymentGatewayReady()) {
        return res.status(503).json({ message: 'Payment gateway is not configured.', code: 'PAYMENT_GATEWAY_NOT_CONFIGURED' });
    }
    const previousId = req.body?.cashfree_order_id || req.body?.cashfreeOrderId;
    if (typeof previousId !== 'string' || !CASHFREE_ORDER_ID_PATTERN.test(previousId)) {
        return res.status(400).json({ message: 'A valid payment order id is required.', code: 'PAYMENT_ORDER_ID_INVALID' });
    }
    try {
        // The previous attempt may actually have been paid — check before charging again.
        const previous = await reconcileCashfreePayment(previousId, 'retry_check');
        if (previous.status === 'NOT_FOUND') {
            return res.status(404).json({ status: 'NOT_FOUND', message: 'Payment order was not found.' });
        }
        if (previous.status === 'PAID') return res.json(previous);
        if (previous.status === 'PAYMENT_PROCESSING') {
            return res.status(409).json({ status: previous.status, message: 'Your last payment is still processing. Please wait a moment.' });
        }
        if (previous.status === 'PAYMENT_PENDING') {
            // The same checkout is still open: reopen it rather than starting another.
            if (!previous.paymentSessionId) {
                return res.status(409).json({ status: previous.status, message: 'Your last payment is still open. Please wait a moment and retry.' });
            }
            return res.json({
                status: 'PAYMENT_PENDING',
                orderId: previous.id,
                paymentSessionId: previous.paymentSessionId,
                cashfreeOrderId: previousId,
                mode: cashfree.getMode()
            });
        }

        // Previous attempt failed: add a new attempt to the same order.
        const intent = await Order.getPaymentIntentByGatewayOrderId(previousId);
        const cashfreeOrderId = newCashfreeOrderId();
        const attempt = await Order.addCashfreeAttempt(intent.order_id, {
            gatewayOrderId: cashfreeOrderId,
            ticketTokenHash: hashTicketToken(createTicketToken(cashfreeOrderId))
        });
        if (!attempt) {
            return res.status(409).json({ message: 'This order already has a payment in progress or is paid. Check its status from the Orders page.' });
        }
        try {
            const session = await openCashfreeCheckout(req, {
                cashfreeOrderId,
                amount: attempt.amount,
                phone: intent.guest_phone,
                email: intent.guest_email
            });
            logPaymentEvent('PAYMENT_INITIATED', { orderId: attempt.id, paymentId: attempt.paymentId, method: 'cashfree', cashfreeOrderId, retry: true });
            return res.json({
                status: 'PAYMENT_PENDING',
                orderId: attempt.id,
                paymentSessionId: session.paymentSessionId,
                cashfreeOrderId,
                mode: cashfree.getMode()
            });
        } catch (error) {
            await Order.failPayment(cashfreeOrderId).catch(() => {});
            throw error;
        }
    } catch (err) {
        const details = paymentCreateErrorDetails(err);
        console.error('[PAYMENT_RETRY_FAILED]', { code: details.code, message: details.message });
        return res.status(details.status && details.status >= 400 && details.status < 600 ? details.status : 502).json({
            message: 'Could not restart the payment. Please retry shortly.',
            code: details.code
        });
    }
});

// POST /api/orders/payment/verify — the Cashfree return page asks the server to
// re-verify. The return URL itself is never proof of payment.
router.post('/payment/verify', pollLimiter, async (req, res) => {
    if (!paymentGatewayReady()) {
        return res.status(503).json({
            status: 'PAYMENT_PENDING',
            message: 'Payment gateway is not configured.',
            code: 'PAYMENT_GATEWAY_NOT_CONFIGURED'
        });
    }
    const cashfreeOrderId = req.body?.cashfree_order_id || req.body?.cashfreeOrderId;
    if (typeof cashfreeOrderId !== 'string' || !CASHFREE_ORDER_ID_PATTERN.test(cashfreeOrderId)) {
        return res.status(400).json({ message: 'A valid payment order id is required.', code: 'PAYMENT_ORDER_ID_INVALID' });
    }

    try {
        const result = await reconcileCashfreePayment(cashfreeOrderId, 'return_verify');
        if (result.status === 'NOT_FOUND') {
            return res.status(404).json({ status: 'NOT_FOUND', message: 'Payment order was not found.' });
        }
        const { paymentSessionId, ...body } = result;
        const pending = result.status === 'PAYMENT_PENDING' || result.status === 'PAYMENT_PROCESSING';
        res.status(pending ? 202 : 200).json(body);
    } catch (error) {
        const safeError = safeOrderError(error);
        console.error('[PAYMENT_VERIFY_FAILED]', {
            stage: 'server_reconciliation',
            cashfreeOrderId,
            code: safeError.code,
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
// The event body is only a hint: the order is always re-fetched from Cashfree.
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
    if (typeof orderId !== 'string' || !CASHFREE_ORDER_ID_PATTERN.test(orderId)) {
        return res.status(200).json({ ok: true, ignored: true });
    }

    try {
        const result = await reconcileCashfreePayment(orderId, 'cashfree_webhook');
        const eventType = String(req.body?.type || req.body?.event || '').toUpperCase();
        const eventPaymentStatus = String(req.body?.data?.payment?.payment_status || '').toUpperCase();
        const indicatesSuccess = eventType.includes('SUCCESS') || eventPaymentStatus === 'SUCCESS';
        if ((result.status === 'PAYMENT_PENDING' || result.status === 'PAYMENT_PROCESSING') && indicatesSuccess) {
            // Ask Cashfree to redeliver once its order status is final.
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


/** Builds the UPI deep link + QR image for a payment (amount + reference from the DB). */


// ── Manual / dev-only methods ────────────────────────────────────────────────

// Legacy manual methods settled outside the app ('whatsapp' = shop's static QR image,
// 'none' = pay at the shop). Not offered in the booking UI any more; kept so existing
// clients keep working. Orders stay PAYMENT_PENDING until a shop admin confirms.
const OFFLINE_PAYMENT_METHODS = ['whatsapp', 'none'];

// POST /api/orders/payment/offline
router.post('/payment/offline', upload.array('files', 10), async (req, res) => {
    const method = req.body.paymentMethod;
    if (!OFFLINE_PAYMENT_METHODS.includes(method)) {
        return res.status(400).json({ message: 'Unknown payment method.' });
    }
    try {
        const validated = await validateAndPriceSubmission(req, res);
        if (!validated) return undefined;
        const ticketToken = crypto.randomBytes(32).toString('hex');
        const order = await createOrderWithFiles(req, {
            data: validated.data,
            resolved: validated.resolved,
            payment: { method },
            ticketTokenHash: hashTicketToken(ticketToken)
        });
        res.status(201).json({ id: order.id, ticketToken, paymentStatus: 'PAYMENT_PENDING' });
    } catch (err) {
        console.error(`${method} order error:`, safeOrderError(err).message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// POST /api/orders/payment/simulate — local testing without Cashfree. Off unless
// ALLOW_SIMULATED_PAYMENTS=true, never in production, never an automatic fallback.
router.post('/payment/simulate', upload.array('files', 10), async (req, res) => {
    if (process.env.NODE_ENV === 'production' || process.env.ALLOW_SIMULATED_PAYMENTS !== 'true') {
        return res.status(404).json({ message: 'Not found.' });
    }
    try {
        const validated = await validateAndPriceSubmission(req, res);
        if (!validated) return undefined;
        const ticketToken = crypto.randomBytes(32).toString('hex');
        const order = await createOrderWithFiles(req, {
            data: validated.data,
            resolved: validated.resolved,
            payment: { method: 'simulated' },
            ticketTokenHash: hashTicketToken(ticketToken)
        });
        const result = await processSuccessfulPayment(order.id, {
            paymentId: order.paymentId,
            method: 'simulated',
            amount: validated.amount,
            transactionRef: `TXN-SIM-${order.id}`,
            source: 'simulated'
        });
        res.status(201).json({ status: 'PAID', id: order.id, ticketNumber: result.ticketNumber, ticketToken });
    } catch (err) {
        console.error('simulated order error:', safeOrderError(err).message);
        res.status(500).json({ message: 'Server Error' });
    }
});
module.exports = router;
// Exposed for tests.
module.exports.orderState = orderState;
module.exports.reconcileCashfreePayment = reconcileCashfreePayment;
