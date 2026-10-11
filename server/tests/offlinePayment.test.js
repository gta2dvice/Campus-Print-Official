const assert = require('node:assert/strict');
const { after, beforeEach, describe, it } = require('node:test');
const pool = require('../db');
const Order = require('../models/Order');

const originalTransaction = pool.transaction;

let state;
let transactionQueue;

// Serializes transactions like the row lock does, against one in-memory order + payment.
function installTransactionStub() {
    pool.transaction = async callback => {
        const previous = transactionQueue;
        let release;
        transactionQueue = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            const tx = {
                async query(sql) {
                    assert.match(sql, /FOR UPDATE OF o, p/);
                    return [[{
                        id: state.orderId,
                        ticket_number: state.ticketNumber,
                        payment_id: 7,
                        payment_status: state.paymentStatus,
                        method: state.method
                    }], { rowCount: 1 }];
                },
                async execute(sql, params) {
                    if (/UPDATE payments SET status = 'success'/i.test(sql)) {
                        if (state.paymentStatus === 'pending') {
                            state.paymentStatus = 'success';
                            state.paymentUpdates += 1;
                        }
                    } else if (/UPDATE orders SET payment_status = 'PAID'/i.test(sql)) {
                        if (!state.ticketNumber) state.ticketCreationCount += 1;
                        state.orderPaymentStatus = 'PAID';
                        state.ticketNumber = state.ticketNumber || params[0];
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

describe('admin offline payment confirmation', () => {
    beforeEach(() => {
        state = {
            orderId: 42,
            method: 'whatsapp',
            paymentStatus: 'pending',
            orderPaymentStatus: 'PAYMENT_PENDING',
            ticketNumber: null,
            ticketCreationCount: 0,
            paymentUpdates: 0
        };
        transactionQueue = Promise.resolve();
        installTransactionStub();
    });

    after(() => {
        pool.transaction = originalTransaction;
    });

    it('settles concurrent confirmations into one paid order and one ticket', async () => {
        const results = await Promise.all(
            Array.from({ length: 6 }, () => Order.confirmOfflinePayment(state.orderId))
        );

        assert.equal(state.paymentStatus, 'success');
        assert.equal(state.orderPaymentStatus, 'PAID');
        assert.equal(state.ticketNumber, 'CP-042');
        assert.equal(state.ticketCreationCount, 1);
        assert.equal(state.paymentUpdates, 1);
        assert.equal(results.filter(Boolean).length, 1);
    });

    it('confirms pay-at-shop orders', async () => {
        state.method = 'none';
        const result = await Order.confirmOfflinePayment(state.orderId);
        assert.deepEqual(result, { id: 42, ticketNumber: 'CP-042' });
    });

    it('refuses to mark a Cashfree payment as paid', async () => {
        state.method = 'cashfree';
        const result = await Order.confirmOfflinePayment(state.orderId);

        assert.equal(result, null);
        assert.equal(state.paymentStatus, 'pending');
        assert.equal(state.orderPaymentStatus, 'PAYMENT_PENDING');
        assert.equal(state.ticketCreationCount, 0);
    });
});
