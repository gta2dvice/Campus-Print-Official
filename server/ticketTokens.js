const crypto = require('crypto');

function getTicketTokenSecret() {
    const secret = process.env.TICKET_TOKEN_SECRET || process.env.CASHFREE_SECRET_KEY;
    if (!secret) {
        throw new Error('TICKET_TOKEN_SECRET or CASHFREE_SECRET_KEY is required for secure ticket access.');
    }
    return secret;
}

function createTicketToken(cashfreeOrderId) {
    return crypto
        .createHmac('sha256', getTicketTokenSecret())
        .update(`campus-print-ticket:${cashfreeOrderId}`)
        .digest('hex');
}

function hashTicketToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function isValidTicketToken(token, expectedHash) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/i.test(token) ||
        typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) {
        return false;
    }
    const actual = Buffer.from(hashTicketToken(token), 'hex');
    const expected = Buffer.from(expectedHash, 'hex');
    return crypto.timingSafeEqual(actual, expected);
}

module.exports = { createTicketToken, hashTicketToken, isValidTicketToken };
