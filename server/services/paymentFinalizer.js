// The single path from "a payment was verified" to "order PAID + ticket".
//
// Every payment method ends here after its own server-side verification:
//   Cashfree  → webhook / return / status poll, after re-fetching the order from Cashfree
//   UPI QR    → shop admin confirms the transfer (a plain UPI QR has no status API)
//   Offline   → shop admin confirms (legacy QR Payment / pay-at-shop orders)
//
// Idempotent and concurrency-safe: the order row, then the payment row, are
// locked; the first caller settles the payment, later callers get the existing
// result. A partial unique index (one 'success' payment per order) backs this up.
// Ticket issuing happens after the payment commits, so a ticket failure leaves a
// recoverable PAID + GENERATION_PENDING order — never a lost or re-charged payment.
const pool = require('../db');
const { logPaymentEvent } = require('./paymentLog');
const { tryEnsureTicket } = require('./ticketService');

const AMOUNT_TOLERANCE = 0.05;

function amountsMatch(a, b) {
    return Number.isFinite(Number(a)) && Number.isFinite(Number(b)) &&
        Math.abs(Number(a) - Number(b)) < AMOUNT_TOLERANCE;
}

function paymentError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

/**
 * @param {number} orderId internal order id
 * @param {object} details
 * @param {number} details.paymentId    the payments row being settled
 * @param {string} details.method       expected payments.method ('cashfree', 'upi_qr', …)
 * @param {number} details.amount       amount verified by the payment source
 * @param {string} [details.currency]   verified currency (default INR)
 * @param {string} [details.transactionRef] gateway / UPI transaction reference
 * @param {string} details.source       who verified it (e.g. 'cashfree_webhook', 'admin')
 * @returns {Promise<{orderId, paymentId, alreadyFinalized, ticketStatus, ticketNumber}>}
 */
async function processSuccessfulPayment(orderId, details) {
    const { paymentId, method, amount, currency = 'INR', transactionRef = null, source } = details;

    const settled = await pool.transaction(async tx => {
        const [orderRows] = await tx.query(
            `SELECT id, total_price, payment_status FROM orders WHERE id = ? FOR UPDATE`,
            [orderId]
        );
        const order = orderRows[0];
        if (!order) throw paymentError('ORDER_NOT_FOUND', 'Order not found.');

        const [paymentRows] = await tx.query(
            `SELECT id, order_id, method, amount, currency, status FROM payments WHERE id = ? FOR UPDATE`,
            [paymentId]
        );
        const payment = paymentRows[0];
        if (!payment || Number(payment.order_id) !== Number(order.id)) {
            throw paymentError('PAYMENT_NOT_FOUND', 'Payment does not belong to this order.');
        }
        if (payment.method !== method) {
            throw paymentError('PAYMENT_METHOD_MISMATCH', 'Payment method does not match the verified source.');
        }

        // Already settled (duplicate webhook / poll / click): return the existing result.
        if (payment.status === 'success') {
            return { alreadyFinalized: true };
        }
        if (payment.status === 'refunded') {
            throw paymentError('PAYMENT_REFUNDED', 'A refunded payment cannot be completed.');
        }

        // The order was already paid by a DIFFERENT attempt: never finalize twice.
        if (order.payment_status === 'PAID') {
            logPaymentEvent('PAYMENT_DUPLICATE_CAPTURE', { orderId: order.id, paymentId: payment.id, source });
            return { alreadyFinalized: true, duplicateCapture: true };
        }

        // Amount + currency are checked against the STORED order, never the client.
        const storedCurrency = String(payment.currency || 'INR').toUpperCase();
        if (String(currency || '').toUpperCase() !== storedCurrency ||
            !amountsMatch(amount, payment.amount) || !amountsMatch(payment.amount, order.total_price)) {
            logPaymentEvent('PAYMENT_REJECTED', {
                orderId: order.id,
                paymentId: payment.id,
                reason: 'AMOUNT_OR_CURRENCY_MISMATCH',
                verifiedAmount: Number(amount),
                orderAmount: Number(order.total_price),
                source
            });
            throw paymentError('PAYMENT_AMOUNT_MISMATCH', 'Verified payment amount or currency does not match the order.');
        }

        await tx.execute(
            `UPDATE payments
             SET status = 'success', paid_at = NOW(), updated_at = NOW(),
                 transaction_ref = COALESCE(?, transaction_ref)
             WHERE id = ? AND status <> 'success'`,
            [transactionRef, payment.id]
        );
        await tx.execute(
            `UPDATE orders
             SET payment_status = 'PAID', paid_at = NOW(),
                 ticket_status = CASE WHEN ticket_status = 'READY' THEN 'READY' ELSE 'GENERATION_PENDING' END
             WHERE id = ?`,
            [order.id]
        );
        return { alreadyFinalized: false };
    });

    if (!settled.alreadyFinalized) {
        logPaymentEvent('PAYMENT_VERIFIED', { orderId, paymentId, method, amount: Number(amount), source });
        logPaymentEvent('ORDER_PAID', { orderId, paymentId, source });
    }

    const ticket = await tryEnsureTicket(orderId);
    return {
        orderId,
        paymentId,
        alreadyFinalized: settled.alreadyFinalized,
        duplicateCapture: Boolean(settled.duplicateCapture),
        ticketStatus: ticket.ticketStatus,
        ticketNumber: ticket.ticketNumber
    };
}

module.exports = { processSuccessfulPayment, amountsMatch };
