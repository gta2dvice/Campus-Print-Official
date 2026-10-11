// Payment finalization, idempotency and recovery — runs the real finalizer,
// ticket service and Order attempt helpers against an in-memory fake DB.
// Run: node --test server/tests/
process.env.TICKET_TOKEN_SECRET = process.env.TICKET_TOKEN_SECRET || 'unit-test-ticket-secret-with-sufficient-entropy';

const assert = require('node:assert/strict');
const { after, beforeEach, describe, it } = require('node:test');
const { createFakeDb, restoreDb } = require('./helpers/fakeDb');
const { processSuccessfulPayment } = require('../services/paymentFinalizer');
const { retryPendingTickets } = require('../services/ticketService');
const Order = require('../models/Order');
const cashfree = require('../cashfree');
const { createTicketToken, hashTicketToken, isValidTicketToken } = require('../ticketTokens');
const ordersRoute = require('../routes/orders');

const silent = { info: console.info, warn: console.warn };
let db;

function successfulTickets() {
    return [...db.orders.values()].filter(o => o.ticket_status === 'READY');
}

function finalize(order, payment, overrides = {}) {
    return processSuccessfulPayment(order.id, {
        paymentId: payment.id,
        method: payment.method,
        amount: payment.amount,
        source: 'test',
        ...overrides
    });
}

beforeEach(() => {
    console.info = () => {};
    console.warn = () => {};
    db = createFakeDb();
    db.install();
});

after(() => {
    restoreDb();
    Object.assign(console, silent);
});

describe('shared payment finalizer', () => {
    it('Cashfree success → one PAID order + one ticket', async () => {
        const order = db.addOrder({ id: 1050, total_price: 42 });
        const payment = db.addPayment({ order_id: 1050, method: 'cashfree', amount: 42 });

        const result = await finalize(order, payment, { transactionRef: 'cf-1' });

        assert.equal(db.orders.get(1050).payment_status, 'PAID');
        assert.equal(db.orders.get(1050).ticket_number, 'CP-1050');
        assert.equal(result.ticketStatus, 'READY');
        assert.equal(db.payments.get(payment.id).transaction_ref, 'cf-1');
    });

    it('UPI QR (admin-confirmed) success → one PAID order + one ticket', async () => {
        const order = db.addOrder({ id: 1051, total_price: 35 });
        const payment = db.addPayment({ order_id: 1051, method: 'upi_qr', amount: 35 });

        const result = await finalize(order, payment);

        assert.equal(result.ticketNumber, 'CP-1051');
        assert.equal(db.orders.get(1051).payment_status, 'PAID');
    });

    it('concurrent duplicate verifications (webhook + return + polls) finalize once', async () => {
        const order = db.addOrder({ id: 7, total_price: 50 });
        const payment = db.addPayment({ order_id: 7, method: 'cashfree', amount: 50 });

        const results = await Promise.all(Array.from({ length: 8 }, () => finalize(order, payment)));

        assert.equal(db.paymentSuccessWrites, 1);
        assert.equal(db.ticketWrites, 1);
        assert.equal(results.filter(r => !r.alreadyFinalized).length, 1);
        assert.ok(results.every(r => r.ticketNumber === 'CP-007'));
    });

    it('the same order finalized again later returns the existing ticket', async () => {
        const order = db.addOrder({ id: 8, total_price: 20 });
        const payment = db.addPayment({ order_id: 8, method: 'upi_qr', amount: 20 });
        await finalize(order, payment);
        const again = await finalize(order, payment);

        assert.equal(again.alreadyFinalized, true);
        assert.equal(again.ticketNumber, 'CP-008');
        assert.equal(db.ticketWrites, 1);
    });

    it('rejects a payment amount that does not match the stored order (₹40 vs ₹50)', async () => {
        const order = db.addOrder({ id: 9, total_price: 50 });
        const payment = db.addPayment({ order_id: 9, method: 'cashfree', amount: 50 });

        await assert.rejects(finalize(order, payment, { amount: 40 }), { code: 'PAYMENT_AMOUNT_MISMATCH' });
        assert.equal(db.orders.get(9).payment_status, 'PAYMENT_PENDING');
        assert.equal(db.payments.get(payment.id).status, 'pending');
        assert.equal(successfulTickets().length, 0);
    });

    it('rejects a payment row whose stored amount differs from the order', async () => {
        const order = db.addOrder({ id: 10, total_price: 50 });
        const payment = db.addPayment({ order_id: 10, method: 'upi_qr', amount: 5 });
        await assert.rejects(finalize(order, payment, { amount: 5 }), { code: 'PAYMENT_AMOUNT_MISMATCH' });
    });

    it('rejects a wrong currency', async () => {
        const order = db.addOrder({ id: 11, total_price: 50 });
        const payment = db.addPayment({ order_id: 11, method: 'cashfree', amount: 50 });
        await assert.rejects(finalize(order, payment, { currency: 'USD' }), { code: 'PAYMENT_AMOUNT_MISMATCH' });
    });

    it('rejects a method mismatch (e.g. an admin trying to settle a Cashfree payment as UPI)', async () => {
        const order = db.addOrder({ id: 12, total_price: 50 });
        const payment = db.addPayment({ order_id: 12, method: 'cashfree', amount: 50 });
        await assert.rejects(finalize(order, payment, { method: 'upi_qr' }), { code: 'PAYMENT_METHOD_MISMATCH' });
    });

    it('rejects a payment that belongs to another order', async () => {
        const a = db.addOrder({ id: 13, total_price: 50 });
        db.addOrder({ id: 14, total_price: 50 });
        const paymentOfB = db.addPayment({ order_id: 14, method: 'cashfree', amount: 50 });
        await assert.rejects(finalize(a, paymentOfB), { code: 'PAYMENT_NOT_FOUND' });
        assert.equal(db.orders.get(14).payment_status, 'PAYMENT_PENDING');
    });

    it('never completes a refunded payment', async () => {
        const order = db.addOrder({ id: 15, total_price: 50 });
        const payment = db.addPayment({ order_id: 15, method: 'cashfree', amount: 50, status: 'refunded' });
        await assert.rejects(finalize(order, payment), { code: 'PAYMENT_REFUNDED' });
    });

    it('a second captured attempt on an already-paid order is not finalized again', async () => {
        const order = db.addOrder({ id: 16, total_price: 30 });
        const first = db.addPayment({ order_id: 16, method: 'cashfree', amount: 30 });
        const second = db.addPayment({ order_id: 16, method: 'cashfree', amount: 30 });
        await finalize(order, first);
        const result = await finalize(order, second);

        assert.equal(result.duplicateCapture, true);
        assert.equal(db.payments.get(second.id).status, 'pending');
        assert.equal(db.ticketWrites, 1);
    });

    it('two independent orders do not affect each other', async () => {
        const a = db.addOrder({ id: 21, total_price: 10 });
        const b = db.addOrder({ id: 22, total_price: 20 });
        const pa = db.addPayment({ order_id: 21, method: 'cashfree', amount: 10 });
        db.addPayment({ order_id: 22, method: 'upi_qr', amount: 20 });

        await finalize(a, pa);

        assert.equal(db.orders.get(21).payment_status, 'PAID');
        assert.equal(db.orders.get(22).payment_status, 'PAYMENT_PENDING');
        assert.equal(db.orders.get(22).ticket_number, null);
    });
});

describe('ticket generation failure and recovery', () => {
    it('payment stays PAID with a recoverable GENERATION_PENDING ticket, then exactly one ticket is issued', async () => {
        const order = db.addOrder({ id: 31, total_price: 25 });
        const payment = db.addPayment({ order_id: 31, method: 'cashfree', amount: 25 });
        db.failTicketWrites = 1;

        const result = await finalize(order, payment);
        assert.equal(result.ticketStatus, 'GENERATION_PENDING');
        assert.equal(db.orders.get(31).payment_status, 'PAID');
        assert.equal(db.orders.get(31).ticket_status, 'GENERATION_PENDING');
        assert.equal(db.payments.get(payment.id).status, 'success');

        // A retried verification does not charge or settle again…
        const retried = await finalize(order, payment);
        assert.equal(retried.alreadyFinalized, true);
        assert.equal(db.paymentSuccessWrites, 1);

        // …and the recovery sweep issues exactly one ticket.
        await Promise.all([retryPendingTickets(), retryPendingTickets()]);
        assert.equal(db.orders.get(31).ticket_status, 'READY');
        assert.equal(db.orders.get(31).ticket_number, 'CP-031');
    });
});

describe('payment attempts (failed → retry → success)', () => {
    it('a failed attempt leaves the order recoverable; a retry adds a new attempt to the SAME order', async () => {
        db.addOrder({ id: 41, total_price: 60, user_id: null, shop_id: 1 });
        const first = db.addPayment({ order_id: 41, method: 'cashfree', amount: 60, gateway_order_id: 'cp_first' });

        await Order.failPayment('cp_first');
        assert.equal(db.payments.get(first.id).status, 'failed');
        assert.equal(db.orders.get(41).payment_status, 'PAYMENT_FAILED');

        const retry = await Order.addCashfreeAttempt(41, { gatewayOrderId: 'cp_second', ticketTokenHash: 'h2' });
        assert.ok(retry);
        assert.equal(db.orders.get(41).payment_status, 'PAYMENT_PENDING');
        // Only one open attempt at a time.
        assert.equal(await Order.addCashfreeAttempt(41, { gatewayOrderId: 'cp_third', ticketTokenHash: 'h3' }), null);

        await processSuccessfulPayment(41, { paymentId: retry.paymentId, method: 'cashfree', amount: 60, source: 'test' });
        const attempts = [...db.payments.values()].filter(p => p.order_id === 41).map(p => p.status);
        assert.deepEqual(attempts, ['failed', 'success']);
        assert.equal(db.orders.get(41).ticket_number, 'CP-041');
        assert.equal(db.orders.size, 1);
    });

    it('a late failure event never downgrades a paid order', async () => {
        const order = db.addOrder({ id: 42, total_price: 15 });
        const payment = db.addPayment({ order_id: 42, method: 'cashfree', amount: 15, gateway_order_id: 'cp_paid' });
        await finalize(order, payment);
        await Order.failPayment('cp_paid');

        assert.equal(db.orders.get(42).payment_status, 'PAID');
        assert.equal(db.payments.get(payment.id).status, 'success');
    });

    it('a failure on an old attempt does not mark a retried order failed', async () => {
        db.addOrder({ id: 43, total_price: 15 });
        const old = db.addPayment({ order_id: 43, method: 'cashfree', amount: 15, gateway_order_id: 'cp_old' });
        db.addPayment({ order_id: 43, method: 'cashfree', amount: 15, gateway_order_id: 'cp_new' });
        await Order.failPayment('cp_old');

        assert.equal(db.payments.get(old.id).status, 'failed');
        assert.equal(db.orders.get(43).payment_status, 'PAYMENT_PENDING');
    });
});

describe('Cashfree reconciliation (server-side verification)', () => {
    const gatewayOrderId = 'cp_123e4567-e89b-42d3-a456-426614174000';
    const stubs = {};

    function stubCashfree({ orderAmount = 50, paidAmount = 50, status = 'PAID', paymentStatus = 'SUCCESS' } = {}) {
        stubs.fetchOrder = cashfree.fetchOrder;
        stubs.fetchOrderPayments = cashfree.fetchOrderPayments;
        cashfree.fetchOrder = async id => ({ order_id: id, order_amount: orderAmount, order_currency: 'INR', order_status: status });
        cashfree.fetchOrderPayments = async () => [{ payment_status: paymentStatus, payment_amount: paidAmount, payment_currency: 'INR', cf_payment_id: 991 }];
    }

    function stubOrderLookups(orderId) {
        for (const name of ['getPaymentIntentByGatewayOrderId', 'getOrderRecord', 'getLatestCashfreeAttempt']) stubs[name] = Order[name];
        Order.getPaymentIntentByGatewayOrderId = async id => {
            const p = [...db.payments.values()].find(x => x.gateway_order_id === id);
            const o = db.orders.get(p.order_id);
            return { payment_id: p.id, order_id: o.id, payment_amount: p.amount, payment_status: p.status, total_price: o.total_price, order_payment_status: o.payment_status };
        };
        Order.getOrderRecord = async id => ({ ...db.orders.get(Number(id)) });
        Order.getLatestCashfreeAttempt = async () => ({ gateway_order_id: gatewayOrderId });
        db.addOrder({ id: orderId, total_price: 50, ticket_access_token_hash: hashTicketToken(createTicketToken(gatewayOrderId)) });
        db.addPayment({ order_id: orderId, method: 'cashfree', amount: 50, gateway_order_id: gatewayOrderId });
    }

    function restore() {
        for (const [name, fn] of Object.entries(stubs)) {
            if (name.startsWith('fetch')) cashfree[name] = fn; else Order[name] = fn;
        }
    }

    it('webhook + return verify + status poll at once → one finalization, valid ticket link', async () => {
        stubCashfree();
        stubOrderLookups(51);
        try {
            const results = await Promise.all([
                ordersRoute.reconcileCashfreePayment(gatewayOrderId, 'cashfree_webhook'),
                ordersRoute.reconcileCashfreePayment(gatewayOrderId, 'return_verify'),
                ordersRoute.reconcileCashfreePayment(gatewayOrderId, 'status_poll')
            ]);
            assert.ok(results.every(r => r.status === 'PAID' && r.ticketNumber === 'CP-051'));
            assert.equal(db.paymentSuccessWrites, 1);
            assert.equal(db.ticketWrites, 1);
            assert.ok(isValidTicketToken(results[0].ticketToken, db.orders.get(51).ticket_access_token_hash));
        } finally {
            restore();
        }
    });

    it('a captured amount different from the order is rejected and nothing is finalized', async () => {
        stubCashfree({ paidAmount: 40 });
        stubOrderLookups(52);
        try {
            await assert.rejects(ordersRoute.reconcileCashfreePayment(gatewayOrderId, 'cashfree_webhook'), { code: 'PAYMENT_ORDER_MISMATCH' });
            assert.equal(db.orders.get(52).payment_status, 'PAYMENT_PENDING');
        } finally {
            restore();
        }
    });

    it('an unpaid Cashfree order stays pending (the return URL alone proves nothing)', async () => {
        stubCashfree({ status: 'ACTIVE', paymentStatus: 'PENDING' });
        stubOrderLookups(53);
        try {
            const result = await ordersRoute.reconcileCashfreePayment(gatewayOrderId, 'return_verify');
            assert.equal(result.status, 'PAYMENT_PROCESSING');
            assert.equal(db.orders.get(53).payment_status, 'PAYMENT_PENDING');
            assert.equal(db.orders.get(53).ticket_number, null);
        } finally {
            restore();
        }
    });
});

describe('order state shown to students', () => {
    const { orderState } = ordersRoute;

    it('maps DB state to UI states', () => {
        assert.equal(orderState({ payment_status: 'PAID', ticket_status: 'READY' }).state, 'TICKET_READY');
        assert.equal(orderState({ payment_status: 'PAID', ticket_status: 'GENERATION_PENDING' }).state, 'TICKET_GENERATION_PENDING');
        assert.equal(orderState({ payment_status: 'PAYMENT_FAILED', ticket_status: 'PENDING_PAYMENT' }).state, 'PAYMENT_FAILED');
        assert.equal(orderState({ payment_status: 'PAYMENT_PENDING' }, null, { processing: true }).state, 'PAYMENT_PROCESSING');
        const expired = { method: 'upi_qr', status: 'pending', qr_expires_at: new Date(Date.now() - 1000) };
        assert.equal(orderState({ payment_status: 'PAYMENT_PENDING' }, expired).state, 'EXPIRED');
        assert.equal(orderState({ payment_status: 'PAID', ticket_status: 'READY' }, { status: 'refunded' }).paymentStatus, 'REFUNDED');
    });
});

describe('Cashfree payment status guards', () => {
    it('recognizes only explicit paid and finalized-failure states', () => {
        assert.equal(cashfree.isOrderPaid({ order_status: 'PAID' }), true);
        assert.equal(cashfree.isOrderPaid({ order_status: 'ACTIVE' }), false);
        assert.equal(cashfree.isPaymentPaid({ payment_status: 'SUCCESS' }), true);
        assert.equal(cashfree.isPaymentPaid({ payment_status: 'PENDING' }), false);
        assert.equal(cashfree.arePaymentsFinalizedAsFailed([{ payment_status: 'FAILED' }, { payment_status: 'USER_DROPPED' }]), true);
        assert.equal(cashfree.arePaymentsFinalizedAsFailed([{ payment_status: 'FAILED' }, { payment_status: 'PENDING' }]), false);
    });
});

describe('ticket link token', () => {
    it('validates the opaque token and rejects altered tokens', () => {
        const token = createTicketToken('cp_123e4567-e89b-42d3-a456-426614174000');
        const tokenHash = hashTicketToken(token);
        assert.equal(token.length, 64);
        assert.equal(isValidTicketToken(token, tokenHash), true);
        assert.equal(isValidTicketToken(`${token.slice(0, -1)}0`, tokenHash), false);
    });
});
