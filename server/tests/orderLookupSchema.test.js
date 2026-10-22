const assert = require('node:assert/strict');
const { describe, it, before, after } = require('node:test');
const express = require('express');
const pool = require('../db');
const Order = require('../models/Order');
const ordersRouter = require('../routes/orders');
const { createTicketToken, hashTicketToken } = require('../ticketTokens');

describe('Order lookup and ticket schema regression tests (PostgreSQL error 42703)', () => {
    const originalExecute = pool.execute;
    const originalQuery = pool.query;

    after(() => {
        pool.execute = originalExecute;
        pool.query = originalQuery;
    });

    it('1. getOrderRecord() SQL does not select u.name from users table', async () => {
        let capturedSql = '';
        pool.execute = async (sql, params) => {
            capturedSql = sql;
            return [[{
                id: 67,
                ticket_number: 'CP-067',
                ticket_status: 'READY',
                payment_status: 'PAID',
                guest_full_name: 'John Doe',
                guest_email: 'john@example.com',
                guest_phone: '9876543210'
            }]];
        };

        const order = await Order.getOrderRecord(67);
        assert.ok(order);
        assert.equal(order.id, 67);
        // Verify SQL does not contain u.name
        assert.doesNotMatch(capturedSql, /\bu\.name\b/i);
        assert.doesNotMatch(capturedSql, /users\.name/i);
        // Verify alias u joins users on u.id = o.user_id
        assert.match(capturedSql, /users\s+u\s+ON\s+u\.id\s*=\s*o\.user_id/i);
        // Verify student_profiles is joined
        assert.match(capturedSql, /student_profiles\s+p\s+ON\s+p\.id\s*=\s*o\.student_id/i);
    });

    it('2. getOrderForUser() and getOrdersByUser() do not select u.name', async () => {
        const captured = [];
        pool.execute = async (sql, params) => {
            captured.push(sql);
            return [[]];
        };

        await Order.getOrderForUser(67, 10);
        await Order.getOrdersByUser(10);

        assert.equal(captured.length, 2);
        for (const sql of captured) {
            assert.doesNotMatch(sql, /\bu\.name\b/i);
            assert.doesNotMatch(sql, /users\.name/i);
        }
    });

    it('3. Safely retrieves existing order CP-067 without regenerating ticket', async () => {
        pool.execute = async (sql, params) => {
            if (/FROM orders/i.test(sql)) {
                return [[{
                    id: 67,
                    ticket_number: 'CP-067',
                    ticket_status: 'READY',
                    payment_status: 'PAID',
                    payment_method: 'CASHFREE',
                    guest_full_name: 'Alice Smith',
                    guest_email: 'alice@example.com',
                    guest_phone: '9988776655',
                    ticket_access_token_hash: hashTicketToken('valid-token-for-67')
                }]];
            }
            return [[]];
        };

        const order = await Order.getOrderRecord(67);
        assert.ok(order);
        assert.equal(order.id, 67);
        assert.equal(order.ticket_number, 'CP-067');
        assert.equal(order.ticket_status, 'READY');
        assert.equal(order.payment_status, 'PAID');
        assert.equal(order.customer_name, 'Alice Smith');
        assert.equal(order.full_name, 'Alice Smith');
        assert.equal(order.customer_phone, '9988776655');
    });

    it('4. Handles student profile customer data when present', async () => {
        pool.execute = async (sql, params) => {
            return [[{
                id: 105,
                ticket_number: 'CP-105',
                ticket_status: 'READY',
                payment_status: 'PAID',
                user_id: 42,
                student_id: 15,
                customer_email: 'student@campus.edu',
                full_name: 'Student Name',
                phone_number: '9123456780',
                class_room_number: 'CR-101'
            }]];
        };

        const order = await Order.getOrderRecord(105);
        assert.ok(order);
        assert.equal(order.id, 105);
        assert.equal(order.customer_email, 'student@campus.edu');
        assert.equal(order.customer_name, 'Student Name');
        assert.equal(order.full_name, 'Student Name');
        assert.equal(order.customer_phone, '9123456780');
    });

    it('5. Handles missing/optional customer data gracefully (returns null, no error)', async () => {
        pool.execute = async (sql, params) => {
            return [[{
                id: 200,
                ticket_number: null,
                ticket_status: 'PENDING_PAYMENT',
                payment_status: 'PAYMENT_PENDING',
                customer_email: null,
                full_name: null,
                guest_full_name: null,
                phone_number: null,
                guest_phone: null
            }]];
        };

        const order = await Order.getOrderRecord(200);
        assert.ok(order);
        assert.equal(order.id, 200);
        assert.equal(order.customer_name, null);
        assert.equal(order.full_name, null);
        assert.equal(order.customer_phone, null);
    });

    it('6. Ticket endpoint GET /api/orders/:id loads order 67 without 42703 error', async () => {
        const token = createTicketToken('order_cf_67');
        const tokenHash = hashTicketToken(token);

        pool.execute = async (sql, params) => {
            if (/FROM orders/i.test(sql) && /WHERE o\.id = \?/i.test(sql)) {
                return [[{
                    id: 67,
                    ticket_number: 'CP-067',
                    ticket_status: 'READY',
                    payment_status: 'PAID',
                    payment_method: 'CASHFREE',
                    total_price: 50.00,
                    guest_full_name: 'Recovered User',
                    guest_email: 'recovered@example.com',
                    guest_phone: '9876543210',
                    ticket_access_token_hash: tokenHash
                }]];
            }
            return [[]];
        };

        pool.query = async (sql, params) => {
            if (/FROM payments WHERE order_id = \?/i.test(sql)) {
                return [[{
                    method: 'cashfree',
                    status: 'success',
                    amount: 50.00,
                    transaction_ref: 'cf_ref_123',
                    qr_expires_at: null
                }]];
            }
            if (/FROM order_ticket_emails WHERE order_id = \?/i.test(sql)) {
                return [[{ status: 'SENT', sent_at: new Date().toISOString(), provider_message_id: 'msg_1' }]];
            }
            return [[]];
        };

        const app = express();
        app.use(express.json());
        // Middleware simulating authorization via ticket-token header
        app.use((req, res, next) => {
            req.headers['x-ticket-token'] = token;
            next();
        });
        app.use('/api/orders', ordersRouter);

        const server = await new Promise(resolve => {
            const s = app.listen(0, () => resolve(s));
        });
        const port = server.address().port;

        try {
            const res = await fetch(`http://localhost:${port}/api/orders/67`, {
                headers: { 'x-ticket-token': token }
            });
            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.id, 67);
            assert.equal(data.ticket_number, 'CP-067');
            assert.equal(data.ticket_status, 'READY');
            assert.equal(data.customer_name, 'Recovered User');
        } finally {
            server.close();
        }
    });
});
