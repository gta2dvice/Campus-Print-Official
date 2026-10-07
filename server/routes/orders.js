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
const slots = require('../slots');
const pool = require('../db');
const { uploadBuffer, buildObjectPath, deleteFiles, downloadFile } = require('../storage');
const cashfree = require('../cashfree');
const { requireProfile } = require('../middleware/roleAuth');
const { createTicketToken, hashTicketToken, isValidTicketToken } = require('../ticketTokens');

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

function calculateTotalPrice(data) {
    const fileSettings = Array.isArray(data.fileSettings)
        ? data.fileSettings
        : data.fileSettings ? JSON.parse(data.fileSettings) : [];
    let printingCost = 0;

    if (fileSettings.length > 0) {
        fileSettings.forEach(f => {
            printingCost += filePrintingCost(f);
        });
    } else {
        return 0; // No files, no cost
    }

    const serviceCharge = PRICING.serviceCharge;
    let deliveryCharge = 0;
    if (data.collectionLocationId === 'hostel-gate') {
        deliveryCharge = PRICING.hostelSurcharge;
    } else if (data.classroomDelivery === 'true' || data.classroomDelivery === true) {
        deliveryCharge = PRICING.classroomDelivery;
    }
    return printingCost + serviceCharge + deliveryCharge;
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
            hasQr: Boolean(shop?.payment_qr_path),
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

// GET /api/orders/ticket/:token — secure bearer access for paid guest tickets.
router.get('/ticket/:token', async (req, res) => {
    try {
        const token = req.params.token;
        const tokenHash = hashTicketToken(token);
        const order = await Order.getOrderByTicketTokenHash(tokenHash);
        if (!order || !isValidTicketToken(token, order.ticket_access_token_hash)) {
            return res.status(404).json({ message: 'Ticket not found.', code: 'TICKET_NOT_FOUND' });
        }
        const [[payment]] = await pool.query(
            `SELECT transaction_ref, method, amount FROM payments WHERE order_id = ? AND status = 'success' LIMIT 1`,
            [order.id]
        );
        const ticket = { ...order };
        delete ticket.ticket_access_token_hash;
        res.json({ ...ticket, payment: payment || null });
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

// GET /api/orders/:id — authenticated order lookup for existing student accounts.
router.get('/:id', async (req, res) => {
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

        if (order.payment_status !== 'PAID') {
            return res.status(404).json({ message: 'Order not found', code: 'ORDER_NOT_FOUND' });
        }
        if (!order.user_id || Number(req.session?.userId) !== Number(order.user_id)) {
            return res.status(403).json({ message: 'Not authorized to view this order' });
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
        const ticket = { ...order };
        delete ticket.ticket_access_token_hash;
        res.json({ ...ticket, payment: payment || null });
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

// POST /api/orders/detect-pages — auto-detects page count per uploaded file (PDF/DOCX get a
// real count; images are always 1; anything else falls back to a flagged 1-page estimate).
router.post('/detect-pages', detectUpload.array('files', 10), async (req, res) => {
    try {
        const files = req.files || [];
        if (files.length === 0) {
            return res.status(400).json({ message: 'No files uploaded for page detection.' });
        }
        const results = await Promise.all(files.map(async (f) => {
            const { pages, estimated } = await detectPages(f);
            return { name: f.originalname, pages, estimated };
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

async function persistUploadedFiles(userId, orderId, files, fileSettings, onStage = () => {}) {
    const stored = [];
    const settingsMap = fileSettings ? JSON.parse(fileSettings) : [];

    try {
        for (const [index, file] of files.entries()) {
            const { storedName, storagePath } = buildObjectPath(userId || 'guest', orderId, file.originalname);
            onStage('file_storage_upload');
            await uploadBuffer({
                storagePath,
                buffer: file.buffer,
                contentType: file.mimetype
            });
            stored.push({
                originalname: file.originalname,
                storedName,
                storagePath,
                mimetype: file.mimetype,
                size: file.size
            });
            console.info('[ORDER_CREATE] File storage upload completed:', {
                orderId,
                fileIndex: index + 1,
                fileCount: files.length
            });
        }
        const finalFiles = stored.map((file, index) => {
            const setting = settingsMap[index] || {};
            return {
                ...file,
                printingSide: setting.printingSide || 'single',
                copies: setting.copies || 1,
                colorMode: setting.colorMode || 'bw'
            };
        });
        onStage('file_metadata_insert');
        await OrderFile.createFiles(orderId, finalFiles);
        return stored.map(file => file.storagePath);
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

async function reconcileCashfreePayment(cashfreeOrderId) {
    const intent = await Order.getPaymentIntentByGatewayOrderId(cashfreeOrderId);
    if (!intent) return { status: 'NOT_FOUND' };
    if (intent.payment_status === 'success' && intent.order_payment_status === 'PAID' && intent.ticket_number) {
        return {
            status: 'PAID',
            id: intent.order_id,
            ticketNumber: intent.ticket_number,
            ticketToken: createTicketToken(cashfreeOrderId)
        };
    }

    const [providerOrder, providerPayments] = await Promise.all([
        cashfree.fetchOrder(cashfreeOrderId),
        cashfree.fetchOrderPayments(cashfreeOrderId)
    ]);
    if (providerOrder.order_id !== cashfreeOrderId ||
        !cashfree.amountsMatch(providerOrder.order_amount, intent.payment_amount) ||
        !cashfree.amountsMatch(intent.payment_amount, intent.total_price) ||
        String(providerOrder.order_currency || '').toUpperCase() !== 'INR') {
        const error = new Error('Cashfree order identity, currency, or amount did not match the persisted order.');
        error.code = 'PAYMENT_ORDER_MISMATCH';
        throw error;
    }

    const successfulPayments = providerPayments.filter(cashfree.isPaymentPaid);
    const successfulPayment = successfulPayments.find(payment =>
        cashfree.amountsMatch(payment.payment_amount, intent.payment_amount) &&
        (!payment.order_id || payment.order_id === cashfreeOrderId) &&
        (!payment.payment_currency || String(payment.payment_currency).toUpperCase() === 'INR')
    );
    if (cashfree.isOrderPaid(providerOrder) && successfulPayments.length && !successfulPayment) {
        const error = new Error('Cashfree captured payment did not match the persisted order amount or currency.');
        error.code = 'PAYMENT_ORDER_MISMATCH';
        throw error;
    }
    if (cashfree.isOrderPaid(providerOrder) && successfulPayment) {
        const ticket = await Order.completePayment(
            cashfreeOrderId,
            successfulPayment.cf_payment_id ? String(successfulPayment.cf_payment_id) : null
        );
        if (!ticket) return { status: 'NOT_FOUND' };
        return {
            status: 'PAID',
            id: ticket.id,
            ticketNumber: ticket.ticketNumber,
            ticketToken: createTicketToken(cashfreeOrderId)
        };
    }

    const orderStatus = String(providerOrder.order_status || '').toUpperCase();
    if (orderStatus === 'EXPIRED' || orderStatus === 'TERMINATED' ||
        cashfree.arePaymentsFinalizedAsFailed(providerPayments)) {
        await Order.failPayment(cashfreeOrderId);
        return { status: 'PAYMENT_FAILED' };
    }
    return { status: 'PAYMENT_PENDING' };
}

// POST /api/orders/payment/create — persists the order intent and files before opening checkout.
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
        const files = req.files || [];
        if (files.length === 0) {
            return res.status(400).json({ message: 'Please upload at least one file to continue.' });
        }
        let fileSettings;
        try {
            fileSettings = typeof body.fileSettings === 'string'
                ? JSON.parse(body.fileSettings)
                : body.fileSettings;
        } catch {
            return res.status(400).json({ message: 'Print settings are invalid. Please review your files and try again.' });
        }
        if (!Array.isArray(fileSettings) || fileSettings.length !== files.length) {
            return res.status(400).json({ message: 'Every uploaded file must have printing settings.' });
        }

        // Server-side price calculation
        const orderData = {
            fileSettings,
            printingSide: req.body.printingSide,
            totalPages: req.body.totalPages,
            collectionLocationId: req.body.collectionLocationId,
            classroomDelivery: req.body.classroomDelivery
        };
        const verifiedAmount = calculateTotalPrice(orderData);

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

        // Server-side price calculation to prevent tampering
        const verifiedPrice = calculateTotalPrice({
            ...data,
            fileSettings: req.body.fileSettings
        });
        data.totalPrice = verifiedPrice;

        data.fileCount = req.files.length;
        data.guestFullName = fullName;
        data.guestPhone = phone;
        data.guestClassroom = classroom;

        const userId = req.session?.userId || null;
        const ticketToken = crypto.randomBytes(32).toString('hex');
        const order = await Order.createOrder(userId, DEFAULT_SHOP_ID, data, {
            ticketTokenHash: hashTicketToken(ticketToken)
        });
        await persistUploadedFiles(userId, order.id, req.files, req.body.fileSettings);
        await Payment.createForOrder(order.id, userId, DEFAULT_SHOP_ID, data.totalPrice || 0, payment.method, payment.transactionRef, { status: payment.status });

        res.status(201).json({ id: order.id, ticketNumber: order.ticketNumber, ticketToken });
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
const OFFLINE_PAYMENT_METHODS = ['whatsapp', 'none'];

// POST /api/orders/payment/offline — QR Payment ('whatsapp') or "pay the shop directly"
router.post('/payment/offline', upload.array('files', 10), (req, res) => {
    const method = req.body.paymentMethod;
    if (!OFFLINE_PAYMENT_METHODS.includes(method)) {
        return res.status(400).json({ message: 'Unknown payment method.' });
    }
    return createGuestOrder(req, res, { method, transactionRef: null, status: 'pending' });
});

// POST /api/orders/payment/verify — reconciles server-verified Cashfree state with the saved intent.
router.post('/payment/verify', async (req, res) => {
    if (!paymentGatewayReady()) {
        return res.status(503).json({
            status: 'PAYMENT_PENDING',
            message: 'Payment gateway is not configured.',
            code: 'PAYMENT_GATEWAY_NOT_CONFIGURED'
        });
    }
    const cashfreeOrderId = req.body?.cashfree_order_id || req.body?.cashfreeOrderId;
    if (typeof cashfreeOrderId !== 'string' || !/^cp_[a-f0-9-]{36}$/i.test(cashfreeOrderId)) {
        return res.status(400).json({ message: 'A valid payment order id is required.', code: 'PAYMENT_ORDER_ID_INVALID' });
    }

    try {
        const result = await reconcileCashfreePayment(cashfreeOrderId);
        if (result.status === 'NOT_FOUND') {
            return res.status(404).json({ status: 'NOT_FOUND', message: 'Payment order was not found.' });
        }
        res.status(result.status === 'PAYMENT_PENDING' ? 202 : 200).json(result);
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
