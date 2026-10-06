const express = require('express');
const multer = require('multer');
const router = express.Router();
const Order = require('../models/Order');
const OrderFile = require('../models/OrderFile');
const Payment = require('../models/Payment');
const { upload } = require('../middleware/upload');
const { detectPages } = require('../pageDetect');
const slots = require('../slots');
const pool = require('../db');
const { uploadBuffer, buildObjectPath } = require('../storage');
const cashfree = require('../cashfree');
const { requireProfile } = require('../middleware/roleAuth');

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

// ── Order Configuration ─────────────────────
const PRICING = {
    single: 2,
    double: 3,
    serviceCharge: 3,
    hostelSurcharge: 4,
    classroomDelivery: 10
};

function calculateTotalPrice(data) {
    const fileSettings = data.fileSettings ? JSON.parse(data.fileSettings) : [];
    let printingCost = 0;

    if (fileSettings.length > 0) {
        fileSettings.forEach(f => {
            const rate = f.colorMode === 'color' ? 5 : (f.printingSide === 'double' ? 3 : 2);
            printingCost += (Number(f.pages) || 0) * (Number(f.copies) || 1) * rate;
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

// GET /api/orders/:id — single order, owner-only (used by the collection ticket page)
router.get('/:id', async (req, res) => {
    try {
        const order = await Order.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found' });

        // If it's a guest order, we show it. If it's a user order, we check session.
        if (order.user_id && req.session && req.session.userId !== order.user_id) {
            return res.status(403).json({ message: 'Not authorized to view this order' });
        }

        const [[payment]] = await pool.query(
            `SELECT transaction_ref, method, amount FROM payments WHERE order_id = ? ORDER BY id DESC LIMIT 1`,
            [order.id]
        );
        res.json({ ...order, payment: payment || null });
    } catch (err) {
        console.error('Get order error:', err);
        res.status(500).json({ message: 'Server Error' });
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

async function persistUploadedFiles(userId, orderId, files, fileSettings) {
    const stored = [];
    const settingsMap = fileSettings ? JSON.parse(fileSettings) : [];
    const settingsById = new Map(settingsMap.map(s => [String(s.key), s]));

    for (const file of files) {
        const { storedName, storagePath } = buildObjectPath(userId, orderId, file.originalname);
        await uploadBuffer({
            storagePath,
            buffer: file.buffer,
            contentType: file.mimetype
        });

        // Find matching settings for this file
        // Note: files array from multer doesn't have keys, but we can match by order/index
        // Actually, it's better to pass settings indexed by the order they come in.
        stored.push({
            originalname: file.originalname,
            storedName,
            storagePath,
            mimetype: file.mimetype,
            size: file.size
        });
    }
    // This needs refinement to link settings to files.
    // Since multer.array('files') preserves order, we can zip them.
    const finalFiles = stored.map((s, idx) => {
        const setting = settingsMap[idx] || {};
        return {
            ...s,
            printingSide: setting.printingSide || 'single',
            copies: setting.copies || 1,
            colorMode: setting.colorMode || 'bw'
        };
    });
    await OrderFile.createFiles(orderId, finalFiles);
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
        // Derived from the server's own clock, not trusted from the client, so a pre-order
        // placed after 5 PM IST is always correctly recorded against tomorrow's date.
        collectionDate: slots.getOrderDateContext().date
    };
}

// POST /api/orders/payment/create — creates a Cashfree order and returns a payment session.
router.post('/payment/create', async (req, res) => {
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
        // Server-side price calculation
        const orderData = {
            fileSettings: req.body.fileSettings,
            printingSide: req.body.printingSide,
            totalPages: req.body.totalPages,
            collectionLocationId: req.body.collectionLocationId
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

        const cashfreeOrderId = `cp_${userId || 'guest'}_${Date.now()}`;
        const requestOrigin = req.get('origin') || '';
        const localFrontendOrigin = /^http:\/\/localhost(?::\d+)?$/.test(requestOrigin)
            ? requestOrigin
            : '';
        const frontend = (localFrontendOrigin || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
        const publicApi = (process.env.PUBLIC_API_URL || '').replace(/\/$/, '');
        const notifyUrl = publicApi ? `${publicApi}/api/orders/payment/webhook` : undefined;
        const returnUrl = `${frontend}/new-order?cf_order={order_id}`;
        let returnOrigin = 'invalid';
        try {
            returnOrigin = new URL(returnUrl).origin;
        } catch {
            // Keep diagnostics safe if a malformed return URL is configured.
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
        if (!session.paymentSessionId) {
            console.error('[PAYMENT_CREATE_FAILED]', {
                stage,
                status: 502,
                code: 'PAYMENT_SESSION_MISSING',
                message: 'Cashfree response did not contain a payment session ID.',
                orderStatus: session.orderStatus || 'unknown'
            });
            return res.status(502).json({
                message: 'Cashfree did not return a payment session. Please try again.',
                code: 'PAYMENT_SESSION_MISSING'
            });
        }

        console.info('[PAYMENT_CREATE] Payment session created:', {
            orderId: cashfreeOrderId,
            paymentSessionReturned: true,
            orderStatus: session.orderStatus || 'unknown'
        });
        res.json({
            paymentSessionId: session.paymentSessionId,
            cashfreeOrderId: session.cashfreeOrderId,
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

// POST /api/orders/payment/simulate — TEMP stand-in or fallback when Cashfree keys fail.
router.post('/payment/simulate', upload.array('files', 10), async (req, res) => {
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
        const order = await Order.createOrder(userId, DEFAULT_SHOP_ID, data);
        await persistUploadedFiles(userId, order.id, req.files, req.body.fileSettings);
        const simulatedRef = `TXN-SIM-${Date.now()}`;
        await Payment.createForOrder(order.id, userId, DEFAULT_SHOP_ID, data.totalPrice || 0, 'simulated', simulatedRef);

        res.status(201).json({ id: order.id, ticketNumber: order.ticketNumber });
    } catch (err) {
        console.error('Simulated payment error:', err);
        res.status(500).json({ message: 'Server Error' });
    }
});

// POST /api/orders/payment/verify — confirms Cashfree order status, then creates the print order.
router.post('/payment/verify', upload.array('files', 10), async (req, res) => {
    if (!paymentGatewayReady()) return res.status(503).json({ message: 'Payment gateway is not configured.' });
    let cashfreeOrderId;
    try {
        cashfreeOrderId = req.body.cashfree_order_id || req.body.cashfreeOrderId;
        if (!cashfreeOrderId) {
            return res.status(400).json({ message: 'Missing payment order id' });
        }
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

        const cfOrder = await cashfree.fetchOrderUntilPaid(cashfreeOrderId);
        if (!cashfree.isOrderPaid(cfOrder)) {
            return res.status(400).json({ message: 'Payment is not completed yet. Please wait or try again.' });
        }

        const existing = await Payment.findByGatewayOrderId(cashfreeOrderId);
        if (existing && existing.order_id) {
            const prior = await Order.getOrderById(existing.order_id);
            if (prior) {
                return res.status(200).json({ id: prior.id, ticketNumber: prior.ticket_number });
            }
            return res.status(409).json({ message: 'This payment is already linked to an order.' });
        }

        const data = readOrderPayload(req.body);
        data.fileCount = req.files.length;
        data.guestFullName = fullName;
        data.guestPhone = phone;
        data.guestClassroom = classroom;

        const pickupErr = slots.pickupError(data.collectionLocationId, data.collectionTime);
        if (pickupErr) return res.status(400).json({ message: pickupErr });

        // Final amount verification before creating the order
        const expectedPrice = calculateTotalPrice({
            ...data,
            fileSettings: req.body.fileSettings
        });
        if (!cashfree.amountsMatch(cfOrder.order_amount, expectedPrice)) {
            return res.status(400).json({ message: 'Payment amount does not match the order requirements.' });
        }
        if (!cashfree.amountsMatch(cfOrder.order_amount, data.totalPrice)) {
            return res.status(400).json({ message: 'Payment amount does not match this order.' });
        }

        const userId = req.session?.userId || null;
        const order = await Order.createOrder(userId, DEFAULT_SHOP_ID, data);
        await persistUploadedFiles(userId, order.id, req.files, req.body.fileSettings);
        const paymentId = cfOrder.cf_payment_id || cfOrder.order_id || cashfreeOrderId;
        await Payment.createForOrder(
            order.id,
            userId,
            DEFAULT_SHOP_ID,
            Number(cfOrder.order_amount) || data.totalPrice || 0,
            'cashfree',
            String(paymentId),
            { status: 'success', gatewayOrderId: cashfreeOrderId }
        );

        res.status(201).json({ id: order.id, ticketNumber: order.ticketNumber });
    } catch (err) {
        if (err.code === '23505' && cashfreeOrderId) {
            const existing = await Payment.findByGatewayOrderId(cashfreeOrderId);
            if (existing?.order_id) {
                const prior = await Order.getOrderById(existing.order_id);
                if (prior) return res.status(200).json({ id: prior.id, ticketNumber: prior.ticketNumber });
            }
        }
        console.error('Payment verify error:', err.response?.data || err.message);
        res.status(500).json({ message: 'Server Error' });
    }
});

// POST /api/orders/payment/webhook — Cashfree server-to-server payment events.
router.post('/payment/webhook', async (req, res) => {
    try {
        if (!paymentGatewayReady()) return res.status(503).json({ message: 'Payment gateway is not configured.' });

        const signature = req.headers['x-webhook-signature'];
        const timestamp = req.headers['x-webhook-timestamp'];
        const rawBody = req.rawBody;
        if (!signature || !timestamp || typeof rawBody !== 'string') {
            return res.status(400).json({ message: 'Missing webhook signature' });
        }

        const tsNum = Number(timestamp);
        if (Number.isFinite(tsNum)) {
            const ageMs = Math.abs(Date.now() - (String(timestamp).length <= 10 ? tsNum * 1000 : tsNum));
            if (ageMs > 15 * 60 * 1000) {
                return res.status(400).json({ message: 'Stale webhook' });
            }
        }

        cashfree.verifyWebhookSignature(signature, rawBody, timestamp);

        const eventType = req.body?.type || req.body?.event || '';
        const orderId = req.body?.data?.order?.order_id;
        const paymentStatus = String(req.body?.data?.payment?.payment_status || '').toUpperCase();
        const cfPaymentId = req.body?.data?.payment?.cf_payment_id;

        if (!orderId) return res.status(200).json({ ok: true });

        let status = null;
        try {
            const cfOrder = await cashfree.fetchOrder(orderId);
            if (cashfree.isOrderPaid(cfOrder)) status = 'success';
            else if (eventType.includes('FAILED') || eventType.includes('USER_DROPPED') || paymentStatus === 'FAILED' || paymentStatus === 'USER_DROPPED') {
                status = 'failed';
            }
        } catch (fetchErr) {
            console.error('Cashfree webhook fetch error:', fetchErr.response?.data || fetchErr.message);
        }

        if (status) {
            await Payment.updateByGatewayOrderId(orderId, {
                status,
                transactionRef: cfPaymentId ? String(cfPaymentId) : undefined
            });
        }

        res.status(200).json({ ok: true });
    } catch (err) {
        console.error('Cashfree webhook error:', err.message);
        res.status(400).json({ message: 'Invalid webhook' });
    }
});

module.exports = router;