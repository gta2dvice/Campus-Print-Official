// Short-lived, HMAC-signed token that authorizes access to ONE specific order's
// ticket (and its documents). A bare sequential order id is never sufficient —
// callers must present either this token or a verified recovery session.
//
// No external dependency: HMAC-SHA256 over the existing session secret.
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || 'campus-print-secret';
// Matches the 24h uploaded-PDF retention window; a ticket link outlives same-day collection.
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24;

function hmac(payload) {
    return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function sign(orderId, ttlMs = DEFAULT_TTL_MS) {
    const exp = Date.now() + ttlMs;
    const payload = `${orderId}.${exp}`;
    const body = Buffer.from(payload).toString('base64url');
    return `${body}.${hmac(payload)}`;
}

function verify(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;

    let payload;
    try {
        payload = Buffer.from(parts[0], 'base64url').toString('utf8');
    } catch {
        return null;
    }

    const expected = hmac(payload);
    const given = Buffer.from(parts[1]);
    const good = Buffer.from(expected);
    if (given.length !== good.length || !crypto.timingSafeEqual(given, good)) return null;

    const [orderIdStr, expStr] = payload.split('.');
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || Date.now() > exp) return null;

    const orderId = Number(orderIdStr);
    if (!Number.isInteger(orderId) || orderId <= 0) return null;

    return { orderId, exp };
}

module.exports = { sign, verify, DEFAULT_TTL_MS };
