const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const pool = require('../db');
const Order = require('../models/Order');

describe('guest Cashfree order intent persistence', () => {
    it('inserts a pending guest order and gateway payment without issuing a ticket', async () => {
        const originalTransaction = pool.transaction;
        const statements = [];
        pool.transaction = async callback => callback({
            async execute(sql, params) {
                statements.push({ sql, params });
                if (/INSERT INTO orders/i.test(sql)) return [{ insertId: 842 }];
                if (/INSERT INTO payments/i.test(sql)) return [{ insertId: 91 }];
                assert.fail(`Unexpected order-intent SQL: ${sql}`);
            }
        });

        try {
            const result = await Order.createOrder(null, 1, {
                paperSize: 'A4',
                copies: 2,
                spiralBinding: false,
                expressDelivery: false,
                totalPrice: 7,
                fileCount: 1,
                collectionLocationId: 'main-gate',
                collectionLocationName: 'Main Gate',
                collectionTime: '12:00 PM',
                collectionDate: '2026-10-09',
                totalPages: 2,
                guestFullName: 'Guest Student',
                guestPhone: '9876543210',
                guestClassroom: 'CSE-A'
            }, {
                payment: {
                    method: 'cashfree',
                    gatewayOrderId: 'cp_123e4567-e89b-42d3-a456-426614174000'
                },
                ticketTokenHash: 'a'.repeat(64)
            });

            assert.deepEqual(result, { id: 842, paymentId: 91, paymentReference: null });
            assert.equal(statements.length, 2);
            assert.match(statements[0].sql, /payment_status,\s*payment_method,\s*ticket_status/);
            assert.match(statements[0].sql, /'PAYMENT_PENDING',\s*\?,\s*'PENDING_PAYMENT'/);
            assert.equal(statements[0].params[0], null);
            assert.equal(statements[0].params[18], 'CASHFREE');
            assert.equal(statements[0].params[19], 'a'.repeat(64));
            assert.match(statements[1].sql, /method,\s*transaction_ref,\s*gateway_order_id/);
            assert.match(statements[1].sql, /'INR',\s*'pending',\s*\?/);
            assert.equal(statements[1].params[4], 'cashfree');
            assert.equal(statements[1].params[6], 'cp_123e4567-e89b-42d3-a456-426614174000');
            assert.equal(statements.some(({ sql }) => /UPDATE orders SET ticket_number/i.test(sql)), false);
        } finally {
            pool.transaction = originalTransaction;
        }
    });
});
