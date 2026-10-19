// Email handling shared across recovery and order workflows.
const crypto = require('crypto');

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

function normalizeEmail(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length > 254 || !EMAIL_REGEX.test(trimmed)) return null;
    return trimmed;
}

// Never log or render a full email address.
// e.g. "alexander@example.com" -> "a***r@example.com", "me@test.com" -> "m*@test.com"
function maskEmail(raw) {
    if (!raw || typeof raw !== 'string') return '****';
    const trimmed = raw.trim().toLowerCase();
    const atIndex = trimmed.indexOf('@');
    if (atIndex <= 0 || atIndex === trimmed.length - 1) return '****';

    const localPart = trimmed.slice(0, atIndex);
    const domainPart = trimmed.slice(atIndex + 1);

    let maskedLocal;
    if (localPart.length <= 2) {
        maskedLocal = `${localPart[0]}*`;
    } else {
        maskedLocal = `${localPart[0]}***${localPart[localPart.length - 1]}`;
    }

    return `${maskedLocal}@${domainPart}`;
}

function emailRateLimitKey(email) {
    const normalized = normalizeEmail(email) || '';
    const secret = process.env.SESSION_SECRET || 'campus-print-secret';
    return crypto.createHmac('sha256', secret).update(normalized).digest('hex').slice(0, 24);
}

module.exports = {
    normalizeEmail,
    maskEmail,
    emailRateLimitKey
};
