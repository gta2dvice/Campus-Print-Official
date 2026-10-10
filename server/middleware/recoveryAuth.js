// Authorization for guest order recovery.
//
// Access to a specific order (ticket + documents) is granted only when the
// caller proves they own it, via ONE of:
//   (a) a valid, unexpired recovery session whose verified phone matches the
//       order's guest_phone (created after OTP verification), or
//   (b) a valid signed ticket token bound to that exact order id, or
//   (c) an authenticated account that owns the order (user order).
//
// A bare /order/:id is never, on its own, sufficient.
const ticketToken = require('../ticketToken');
const { normalizePhone } = require('../phone');

// Short-lived recovery session, independent of the 1-day cookie lifetime.
const RECOVERY_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

function establishRecoverySession(req, phone) {
    req.session.recovery = { phone, expiresAt: Date.now() + RECOVERY_SESSION_TTL_MS };
}

function activeRecoveryPhone(req) {
    const rec = req.session && req.session.recovery;
    if (!rec || !rec.phone || !rec.expiresAt) return null;
    if (Date.now() > rec.expiresAt) return null;
    return rec.phone;
}

// Gate for phone-scoped endpoints (e.g. GET /history). Requires a live session.
function requireRecoverySession(req, res, next) {
    const phone = activeRecoveryPhone(req);
    if (!phone) {
        return res.status(401).json({
            message: 'Your recovery session has expired. Please verify your phone number again.',
            code: 'RECOVERY_SESSION_REQUIRED'
        });
    }
    req.recoveryPhone = phone;
    next();
}

// Returns true when the request is authorized for THIS order.
function isAuthorizedForOrder(req, order) {
    if (!order) return false;

    // (b) ticket token bound to this order
    const token = (req.query && req.query.token) || (req.headers && req.headers['x-ticket-token']);
    const decoded = ticketToken.verify(token);
    if (decoded && String(decoded.orderId) === String(order.id)) return true;

    // (a) recovery session whose phone matches the order's guest phone
    const sessionPhone = activeRecoveryPhone(req);
    if (sessionPhone) {
        const a = normalizePhone(sessionPhone);
        const b = normalizePhone(order.guest_phone);
        if (a && b && a === b) return true;
    }

    // (c) authenticated owner of a user order
    if (order.user_id && req.session && req.session.userId === order.user_id) return true;

    return false;
}

module.exports = {
    RECOVERY_SESSION_TTL_MS,
    establishRecoverySession,
    activeRecoveryPhone,
    requireRecoverySession,
    isAuthorizedForOrder
};
