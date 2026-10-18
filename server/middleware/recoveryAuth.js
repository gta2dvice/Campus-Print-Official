// Authorization for guest order recovery via email OTP.
//
// Access to a specific order (ticket + documents) is granted only when the
// caller proves they own it, via ONE of:
//   (a) a valid, unexpired recovery session whose verified email matches the
//       order's guest_email or the order's user account email (customer_email), or
//   (b) the order's ticket link token (only its hash is stored on the order), or
//   (c) an authenticated account that owns the order (user order).
//
// A bare /order/:id is never, on its own, sufficient.
const { isValidTicketToken } = require('../ticketTokens');
const { normalizeEmail } = require('../email');

// Short-lived recovery session, independent of the 1-day cookie lifetime.
const RECOVERY_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function establishRecoverySession(req, email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    req.session.recovery = { email: normalized, expiresAt: Date.now() + RECOVERY_SESSION_TTL_MS };
}

function clearRecoverySession(req) {
    if (req.session && req.session.recovery) {
        delete req.session.recovery;
    }
}

function activeRecoveryEmail(req) {
    const rec = req.session && req.session.recovery;
    if (!rec || !rec.email || !rec.expiresAt) return null;
    if (Date.now() > rec.expiresAt) return null;
    return normalizeEmail(rec.email);
}

// Gate for email-scoped endpoints (e.g. GET /history). Requires a live recovery session.
function requireRecoverySession(req, res, next) {
    const email = activeRecoveryEmail(req);
    if (!email) {
        return res.status(401).json({
            message: 'Your recovery session has expired. Please verify your email address again.',
            code: 'RECOVERY_SESSION_REQUIRED'
        });
    }
    req.recoveryEmail = email;
    next();
}

// Returns true when the request is authorized for THIS order.
function isAuthorizedForOrder(req, order) {
    if (!order) return false;

    // (b) ticket link token for this order
    const token = (req.headers && req.headers['x-ticket-token']) || (req.query && req.query.token);
    if (token && isValidTicketToken(String(token), order.ticket_access_token_hash)) return true;

    // (a) recovery session whose email matches the order's guest email or user email
    const sessionEmail = activeRecoveryEmail(req);
    if (sessionEmail) {
        const normSession = normalizeEmail(sessionEmail);
        const normGuest = normalizeEmail(order.guest_email);
        const normCustomer = normalizeEmail(order.customer_email);
        if (normSession && (normSession === normGuest || normSession === normCustomer)) return true;
    }

    // (c) authenticated owner of a user order
    if (order.user_id && Number(req.session?.userId) === Number(order.user_id)) return true;

    return false;
}

module.exports = {
    RECOVERY_SESSION_TTL_MS,
    establishRecoverySession,
    clearRecoverySession,
    activeRecoveryEmail,
    requireRecoverySession,
    isAuthorizedForOrder
};
