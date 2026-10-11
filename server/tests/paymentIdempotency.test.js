const assert = require('node:assert/strict');
const { after, beforeEach, describe, it } = require('node:test');
const pool = require('../db');
const Order = require('../models/Order');
const cashfree = require('../cashfree');
const { createTicketToken, hashTicketToken, isValidTicketToken } = require('../ticketTokens');

const originalTransaction = pool.transaction;
const originalTokenSecret = process.env.TICKET_TOKEN_SECRET;
const gatewayOrderId = 'cp_123e4567-e89b-42d3-a456-426614174000';

let state;
let transactionQueue;

function installTransactionStub() {
    pool.transaction = async callback => {
        const previous = transactionQueue;
        let release;
        transactionQueue = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            const tx = {
                async query(sql) {
                    assert.match(sql, /FOR UPDATE OF p, o/);
                    return [[{
                        order_id: state.orderId,
                        payment_status: state.paymentStatus,
                        ticket_number: state.ticketNumber
                    }], { rowCount: 1 }];
                },
                async execute(sql, params) {
                    if (/UPDATE payments\s+SET status = 'success'/i.test(sql)) {
                        if (state.paymentStatus !== 'refunded') {
                            state.paymentStatus = 'success';
                            state.transactionRef = params[0];
                        }
                    } else if (/UPDATE orders\s+SET payment_status = 'PAID'/i.test(sql)) {
                        if (!state.ticketNumber) state.ticketCreationCount += 1;
                        state.orderPaymentStatus = 'PAID';
                        state.ticketNumber = state.ticketNumber || params[0];
                    } else if (/UPDATE payments SET status = 'failed'/i.test(sql)) {
                        if (state.paymentStatus === 'pending') state.paymentStatus = 'failed';
                    } else if (/UPDATE orders SET payment_status = 'PAYMENT_FAILED'/i.test(sql)) {
                        if (state.orderPaymentStatus === 'PAYMENT_PENDING') {
                            state.orderPaymentStatus = 'PAYMENT_FAILED';
                        }
                    } else {
                        assert.fail(`Unexpected transaction SQL: ${sql}`);
                    }
                    return [{ rowCount: 1 }];
                }
            };
            return await callback(tx);
        } finally {
            release();
        }
    };
}

describe('payment settlement idempotency', () => {
    beforeEach(() => {
        state = {
            orderId: 321,
            paymentStatus: 'pending',
            orderPaymentStatus: 'PAYMENT_PENDING',
            ticketNumber: null,
            ticketCreationCount: 0,
            transactionRef: null
        };
        transactionQueue = Promise.resolve();
        installTransactionStub();
    });

    after(() => {
        pool.transaction = originalTransaction;
        if (originalTokenSecret === undefined) delete process.env.TICKET_TOKEN_SECRET;
        else process.env.TICKET_TOKEN_SECRET = originalTokenSecret;
    });

    it('settles concurrent duplicate verifications into one order ticket', async () => {
        const results = await Promise.all(
            Array.from({ length: 8 }, () => Order.completePayment(gatewayOrderId, 'cf-payment-1'))
        );

        assert.equal(state.paymentStatus, 'success');
        assert.equal(state.orderPaymentStatus, 'PAID');
        assert.equal(state.ticketNumber, 'CP-321');
        assert.equal(state.ticketCreationCount, 1);
        assert.ok(results.every(result => result.id === 321 && result.ticketNumber === 'CP-321'));
    });

    it('marks a failed payment without creating a ticket', async () => {
        await Order.failPayment(gatewayOrderId);

        assert.equal(state.paymentStatus, 'failed');
        assert.equal(state.orderPaymentStatus, 'PAYMENT_FAILED');
        assert.equal(state.ticketNumber, null);
        assert.equal(state.ticketCreationCount, 0);
    });

    it('does not let a delayed failure event downgrade a paid order', async () => {
        await Order.completePayment(gatewayOrderId, 'cf-payment-1');
        await Order.failPayment(gatewayOrderId);

        assert.equal(state.paymentStatus, 'success');
        assert.equal(state.orderPaymentStatus, 'PAID');
        assert.equal(state.ticketCreationCount, 1);
    });
});

describe('guest ticket access token', () => {
    beforeEach(() => {
        process.env.TICKET_TOKEN_SECRET = 'unit-test-ticket-secret-with-sufficient-entropy';
    });

    describe('Cashfree payment status guards', () => {
        it('recognizes only explicit paid and finalized-failure states', () => {
            assert.equal(cashfree.isOrderPaid({ order_status: 'PAID' }), true);
            assert.equal(cashfree.isOrderPaid({ order_status: 'ACTIVE' }), false);
            assert.equal(cashfree.isPaymentPaid({ payment_status: 'SUCCESS' }), true);
            assert.equal(cashfree.isPaymentPaid({ payment_status: 'PENDING' }), false);
            assert.equal(cashfree.arePaymentsFinalizedAsFailed([
                { payment_status: 'FAILED' },
                { payment_status: 'USER_DROPPED' }
            ]), true);
            assert.equal(cashfree.arePaymentsFinalizedAsFailed([
                { payment_status: 'FAILED' },
                { payment_status: 'PENDING' }
            ]), false);
        });
    });

    it('validates the opaque ticket token and rejects altered tokens', () => {
        const token = createTicketToken(gatewayOrderId);
        const tokenHash = hashTicketToken(token);

        assert.equal(token.length, 64);
        assert.equal(isValidTicketToken(token, tokenHash), true);
        assert.equal(isValidTicketToken(`${token.slice(0, -1)}0`, tokenHash), false);
    });
});
