// The one place a collection ticket is issued. A ticket belongs to exactly one
// order (orders.ticket_number, unique) and is issued only for a PAID order.
// Safe to call any number of times, concurrently: the order row is locked and an
// existing ticket is returned unchanged.
const pool = require('../db');
const { logPaymentEvent } = require('./paymentLog');

function ticketNumberFor(orderId) {
    return `CP-${String(orderId).padStart(3, '0')}`;
}

/**
 * Issues (or returns) the ticket for a paid order.
 * Returns { orderId, ticketStatus, ticketNumber }, where ticketStatus is
 * PENDING_PAYMENT (not paid yet — no ticket) or READY.
 */
async function ensureTicket(orderId) {
    return pool.transaction(async tx => {
        const [rows] = await tx.query(
            `SELECT id, payment_status, ticket_status, ticket_number FROM orders WHERE id = ? FOR UPDATE`,
            [orderId]
        );
        const order = rows[0];
        if (!order) {
            const error = new Error('Order not found.');
            error.code = 'ORDER_NOT_FOUND';
            throw error;
        }
        if (order.payment_status !== 'PAID') {
            return { orderId: order.id, ticketStatus: 'PENDING_PAYMENT', ticketNumber: null };
        }
        if (order.ticket_status === 'READY' && order.ticket_number) {
            logPaymentEvent('TICKET_ALREADY_EXISTS', { orderId: order.id, ticketNumber: order.ticket_number });
            return { orderId: order.id, ticketStatus: 'READY', ticketNumber: order.ticket_number };
        }

        const ticketNumber = order.ticket_number || ticketNumberFor(order.id);
        await tx.execute(
            `UPDATE orders SET ticket_number = ?, ticket_status = 'READY' WHERE id = ?`,
            [ticketNumber, order.id]
        );
        logPaymentEvent('TICKET_GENERATED', { orderId: order.id, ticketNumber });
        return { orderId: order.id, ticketStatus: 'READY', ticketNumber };
    });
}

/**
 * Like ensureTicket, but never throws: a failure leaves the order PAID with
 * ticket_status GENERATION_PENDING, which the recovery sweep and any later
 * status/ticket request retry. The customer is never charged again.
 */
async function tryEnsureTicket(orderId) {
    try {
        return await ensureTicket(orderId);
    } catch (error) {
        logPaymentEvent('TICKET_GENERATION_FAILED', {
            orderId,
            code: String(error.code || 'TICKET_GENERATION_FAILED').slice(0, 64)
        });
        return { orderId, ticketStatus: 'GENERATION_PENDING', ticketNumber: null };
    }
}

/** Recovery sweep: issues tickets for paid orders still waiting on one. */
async function retryPendingTickets(limit = 50) {
    const [rows] = await pool.query(
        `SELECT id FROM orders
         WHERE payment_status = 'PAID' AND ticket_status = 'GENERATION_PENDING'
         ORDER BY id LIMIT ?`,
        [limit]
    );
    let issued = 0;
    for (const row of rows) {
        const result = await tryEnsureTicket(row.id);
        if (result.ticketStatus === 'READY') issued += 1;
    }
    return { pending: rows.length, issued };
}

module.exports = { ensureTicket, tryEnsureTicket, retryPendingTickets, ticketNumberFor };
