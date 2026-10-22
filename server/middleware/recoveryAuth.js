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
const User = require('../models/User');

// Short-lived recovery session, independent of the 1-day cookie lifetime.
const RECOVERY_SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

class AuthorizationError extends Error {
    constructor(code, message, status = 403) {
        super(message);
        this.name = 'AuthorizationError';
        this.code = code;
        this.status = status;
    }
}

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

/**
 * Pure logic to determine if an identity (email/userId) owns an order.
 * Handles legacy cases where emails may be NULL but userId is present.
 */
function canAccessOrder({ sessionEmail, sessionUserId, order }) {
    if (!order) return false;

    // 1. Direct Email Match (Normalized)
    if (sessionEmail) {
        const normSession = normalizeEmail(sessionEmail);
        const normGuest = normalizeEmail(order.guest_email);
        const normCustomer = normalizeEmail(order.customer_email);

        if (normSession && (normSession === normGuest || normSession === normCustomer)) {
            return true;
        }
    }

    // 2. User ID Match (Authenticated or Resolved from Recovery Email)
    if (sessionUserId && order.user_id) {
        if (Number(sessionUserId) === Number(order.user_id)) {
            return true;
        }
    }

    return false;
}

/**
 * Canonical Resolver for ticket/order access.
 * Replaces isAuthorizedForOrder.
 */
async function resolveTicketAccess(req, order) {
    if (!order) {
        throw new AuthorizationError('ORDER_NOT_FOUND', 'This ticket link is no longer valid.', 404);
    }

    // (a) Secure ticket token check (High priority)
    const token = (req.headers && req.headers['x-ticket-token']) || (req.query && req.query.token);
    if (token && isValidTicketToken(String(token), order.ticket_access_token_hash)) {
        return { authorized: true, method: 'TICKET_TOKEN' };
    }

    // (b) Identify requester
    const sessionEmail = activeRecoveryEmail(req);
    const sessionUserId = req.session?.userId;

    let resolvedUserId = sessionUserId;

    // If we have a recovery email but no auth session, resolve the email to a userId
    if (sessionEmail && !resolvedUserId) {
        const user = await User.findByEmail(sessionEmail);
        if (user) {
            resolvedUserId = user.id;
        }
    }

    // (c) Unified Ownership Check
    if (canAccessOrder({ sessionEmail, sessionUserId: resolvedUserId, order })) {
        return {
            authorized: true,
            method: sessionUserId ? 'AUTHENTICATED_USER' : (sessionEmail ? 'RECOVERY_SESSION' : 'UNKNOWN')
        };
    }

    throw new AuthorizationError('NOT_AUTHORIZED', 'You are not authorized to view this order.', 403);
}

module.exports = {
    RECOVERY_SESSION_TTL_MS,
    establishRecoverySession,
    clearRecoverySession,
    activeRecoveryEmail,
    requireRecoverySession,
    resolveTicketAccess,
    AuthorizationError
};

