// In-memory stand-in for the orders/payments tables, wired into server/db.js.
// It understands exactly the SQL used by the payment finalizer, the ticket
// service and Order's attempt helpers, and fails loudly on anything else.
//
// Transactions are serialized (like the row locks they take in Postgres), and the
// partial unique index "one successful payment per order" is enforced, so tests
// can fire concurrent duplicate requests and observe the real outcome.
const assert = require('node:assert/strict');
const pool = require('../../db');

const original = { transaction: pool.transaction, query: pool.query, execute: pool.execute };

function createFakeDb() {
    const db = {
        orders: new Map(),
        payments: new Map(),
        nextPaymentId: 1,
        failTicketWrites: 0,      // > 0: the next N ticket writes throw
        ticketWrites: 0,
        paymentSuccessWrites: 0
    };

    function one(map, id) {
        return map.get(Number(id));
    }

    function run(sql, params = []) {
        const s = sql.replace(/\s+/g, ' ').trim();

        // ── orders ──
        if (/^SELECT id, total_price, payment_status FROM orders WHERE id = \? FOR UPDATE$/.test(s) ||
            /^SELECT id, payment_status, ticket_status, ticket_number FROM orders WHERE id = \? FOR UPDATE$/.test(s) ||
            /^SELECT id FROM orders WHERE id = \? FOR UPDATE$/.test(s) ||
            /^SELECT id, user_id, shop_id, total_price, payment_status FROM orders WHERE id = \? FOR UPDATE$/.test(s)) {
            const order = one(db.orders, params[0]);
            return [order ? [{ ...order }] : []];
        }
        if (/^UPDATE orders SET payment_status = 'PAID', paid_at = NOW\(\)/.test(s)) {
            const order = one(db.orders, params[0]);
            order.payment_status = 'PAID';
            order.ticket_status = order.ticket_status === 'READY' ? 'READY' : 'GENERATION_PENDING';
            return [{ rowCount: 1 }];
        }
        if (/^UPDATE orders SET ticket_number = \?, ticket_status = 'READY' WHERE id = \?$/.test(s)) {
            db.ticketWrites += 1;
            if (db.failTicketWrites > 0) {
                db.failTicketWrites -= 1;
                const error = new Error('simulated ticket write failure');
                error.code = 'SIMULATED';
                throw error;
            }
            const order = one(db.orders, params[1]);
            order.ticket_number = params[0];
            order.ticket_status = 'READY';
            return [{ rowCount: 1 }];
        }
        if (/^UPDATE orders SET payment_status = 'PAYMENT_FAILED'/.test(s)) {
            const order = one(db.orders, params[0]);
            const open = [...db.payments.values()].some(p => p.order_id === order.id && ['pending', 'success'].includes(p.status));
            if (order.payment_status === 'PAYMENT_PENDING' && !open) order.payment_status = 'PAYMENT_FAILED';
            return [{ rowCount: 1 }];
        }
        if (/^UPDATE orders SET payment_status = 'PAYMENT_PENDING', ticket_access_token_hash = \? WHERE id = \?$/.test(s)) {
            const order = one(db.orders, params[1]);
            order.payment_status = 'PAYMENT_PENDING';
            order.ticket_access_token_hash = params[0];
            return [{ rowCount: 1 }];
        }
        if (/^SELECT id FROM orders WHERE payment_status = 'PAID' AND ticket_status = 'GENERATION_PENDING'/.test(s)) {
            return [[...db.orders.values()]
                .filter(o => o.payment_status === 'PAID' && o.ticket_status === 'GENERATION_PENDING')
                .map(o => ({ id: o.id }))];
        }

        // ── payments ──
        if (/^SELECT id, order_id, method, amount, currency, status FROM payments WHERE id = \? FOR UPDATE$/.test(s) ||
            /^SELECT id, status FROM payments WHERE id = \? FOR UPDATE$/.test(s)) {
            const payment = one(db.payments, params[0]);
            return [payment ? [{ ...payment }] : []];
        }
        if (/^SELECT id FROM payments WHERE gateway_order_id = \?$/.test(s)) {
            const payment = [...db.payments.values()].find(p => p.gateway_order_id === params[0]);
            return [payment ? [{ id: payment.id }] : []];
        }
        if (/^SELECT order_id FROM payments WHERE id = \?$/.test(s)) {
            const payment = one(db.payments, params[0]);
            return [payment ? [{ order_id: payment.order_id }] : []];
        }
        if (/^SELECT 1 FROM payments WHERE order_id = \? AND status IN \('pending', 'success'\) LIMIT 1$/.test(s)) {
            const open = [...db.payments.values()].some(p => p.order_id === Number(params[0]) && ['pending', 'success'].includes(p.status));
            return [open ? [{ 1: 1 }] : []];
        }
        if (/^UPDATE payments SET status = 'success', paid_at = NOW\(\)/.test(s)) {
            const [transactionRef, id] = params;
            const payment = one(db.payments, id);
            if (payment.status === 'success') return [{ rowCount: 0 }];
            // Partial unique index: one successful payment per order.
            const clash = [...db.payments.values()].some(p => p.order_id === payment.order_id && p.status === 'success');
            if (clash) {
                const error = new Error('duplicate key value violates unique constraint "idx_payments_one_success_per_order"');
                error.code = '23505';
                throw error;
            }
            payment.status = 'success';
            payment.transaction_ref = transactionRef || payment.transaction_ref;
            db.paymentSuccessWrites += 1;
            return [{ rowCount: 1 }];
        }
        if (/^UPDATE payments SET status = 'failed', updated_at = NOW\(\) WHERE id = \? AND status = 'pending'$/.test(s)) {
            const payment = one(db.payments, params[0]);
            if (payment.status === 'pending') payment.status = 'failed';
            return [{ rowCount: 1 }];
        }
        if (/^INSERT INTO payments/.test(s)) {
            const [orderId, , , amount, method, transactionRef, gatewayOrderId] = params;
            const id = db.nextPaymentId++;
            db.payments.set(id, { id, order_id: Number(orderId), method, amount: Number(amount), currency: 'INR', status: 'pending', transaction_ref: transactionRef, gateway_order_id: gatewayOrderId });
            return [{ insertId: id, rowCount: 1 }];
        }

        assert.fail(`fakeDb: unexpected SQL: ${s}`);
    }

    let queue = Promise.resolve();
    function install() {
        pool.transaction = async callback => {
            const previous = queue;
            let release;
            queue = new Promise(resolve => { release = resolve; });
            await previous;
            try {
                const tx = { query: async (sql, params) => run(sql, params), execute: async (sql, params) => run(sql, params) };
                return await callback(tx);
            } finally {
                release();
            }
        };
        pool.query = async (sql, params) => run(sql, params);
        pool.execute = async (sql, params) => run(sql, params);
    }

    db.addOrder = (order) => {
        db.orders.set(order.id, { payment_status: 'PAYMENT_PENDING', ticket_status: 'PENDING_PAYMENT', ticket_number: null, ...order });
        return db.orders.get(order.id);
    };
    db.addPayment = (payment) => {
        const id = db.nextPaymentId++;
        db.payments.set(id, { id, currency: 'INR', status: 'pending', transaction_ref: null, ...payment });
        return db.payments.get(id);
    };
    db.install = install;
    return db;
}

function restoreDb() {
    Object.assign(pool, original);
}

module.exports = { createFakeDb, restoreDb };
