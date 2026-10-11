// Structured payment lifecycle events. Only identifiers, amounts and states are
// logged — never keys, secrets, OTPs, UPI PINs, card data or customer details.
const EVENTS = new Set([
    'ORDER_CREATED',
    'PAYMENT_INITIATED',
    'PAYMENT_VERIFIED',
    'PAYMENT_FAILED',
    'PAYMENT_REJECTED',
    'PAYMENT_DUPLICATE_CAPTURE',
    'ORDER_PAID',
    'TICKET_GENERATED',
    'TICKET_ALREADY_EXISTS',
    'TICKET_GENERATION_FAILED'
]);

const WARN_EVENTS = new Set(['PAYMENT_FAILED', 'PAYMENT_REJECTED', 'PAYMENT_DUPLICATE_CAPTURE', 'TICKET_GENERATION_FAILED']);

function logPaymentEvent(event, details = {}) {
    if (!EVENTS.has(event)) throw new Error(`Unknown payment event: ${event}`);
    const log = WARN_EVENTS.has(event) ? console.warn : console.info;
    log(`[${event}]`, details);
}

module.exports = { logPaymentEvent };
