require('./loadEnv');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const session = require('express-session');

const authRoutes = require('./routes/auth');
const orderRoutes = require('./routes/orders');
const adminRoutes = require('./routes/admin');
const superAdminRoutes = require('./routes/superAdmin');
const internalRoutes = require('./routes/internal');
const { cleanupExpiredPdfs } = require('./jobs/cleanupExpiredPdfs');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────
// CORS configuration
function normalizeOrigin(value) {
    if (!value) return null;

    let parsed;
    try {
        parsed = new URL(value.trim());
    } catch {
        return null;
    }

    if (!['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== '/' ||
        parsed.search ||
        parsed.hash) {
        return null;
    }

    return parsed.origin;
}

const configuredOriginValues = [
    process.env.FRONTEND_URL,
    ...(process.env.CORS_ORIGINS || '').split(',')
].map(origin => (origin || '').trim()).filter(Boolean);
const configuredFrontendOrigins = configuredOriginValues
    .map(normalizeOrigin)
    .filter(Boolean);
if (configuredFrontendOrigins.length !== configuredOriginValues.length) {
    console.warn('[CORS_CONFIG] Ignoring invalid frontend origin configuration; use origins without paths, query strings, or credentials.');
}
const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    ...configuredFrontendOrigins
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.warn(`[CORS_REJECTED]\norigin: ${origin}`);
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    optionsSuccessStatus: 204,
    preflightContinue: false
}));
function isCashfreeWebhook(req) {
    return req.originalUrl.split('?')[0] === '/api/orders/payment/webhook';
}

app.use('/api/orders/payment/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
    req.rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    try {
        req.body = JSON.parse(req.rawBody || '{}');
    } catch {
        req.body = {};
    }
    next();
});

app.use((req, res, next) => {
    if (isCashfreeWebhook(req)) return next();
    express.json()(req, res, next);
});
app.use((req, res, next) => {
    if (isCashfreeWebhook(req)) return next();
    express.urlencoded({ extended: true })(req, res, next);
});

// Session
app.use(session({
    secret: process.env.SESSION_SECRET || 'campus-print-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 1000 * 60 * 60 * 24, // 1 day
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax'
    }
}));

// ── API Routes ───────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/internal', internalRoutes);

const sendHealth = (req, res) => {
    res.status(200).json({
        status: 'ok',
        service: 'campus-print-api',
        commit: process.env.RENDER_GIT_COMMIT || null
    });
};
app.get('/health', sendHealth);

// ── React SPA (built by client-react) — public site + admin + super-admin ────
// Auth/role guards live client-side in the React app (each page/layout
// checks session status via the API routes above and redirects as needed).
const CLIENT_DIST = path.join(__dirname, '../client-react/dist');
const CLIENT_INDEX = path.join(CLIENT_DIST, 'index.html');
if (fs.existsSync(CLIENT_INDEX)) {
    console.log('Serving static files from:', CLIENT_DIST);
    app.use(express.static(CLIENT_DIST));
    app.get(/^(?!\/api\/).*/, (req, res) => {
        res.sendFile(CLIENT_INDEX);
    });
} else {
    console.log('No client build found; running as API-only server.');
    app.get('/', sendHealth);
}

// ── Start Server ─────────────────────────────────
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    const hour = 60 * 60 * 1000;
    setInterval(() => {
        cleanupExpiredPdfs()
            .then(result => console.log('PDF cleanup:', result))
            .catch(err => console.error('PDF cleanup error:', err.message));
    }, hour);
    cleanupExpiredPdfs().catch(err => console.error('Initial PDF cleanup error:', err.message));
});
