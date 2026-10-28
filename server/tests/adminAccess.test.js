// Role separation over real HTTP: a Printer Admin session must never receive
// customer totals or Campus Print charges, and must be refused by every Super
// Admin financial / payment endpoint. Models are stubbed with rich rows that DO
// contain those fields, so any leak through a route shows up here.
// Run: node --test server/tests/
const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');
const express = require('express');
const Order = require('../models/Order');
const OrderFile = require('../models/OrderFile');
const Payment = require('../models/Payment');

const FORBIDDEN_KEYS = ['total_price', 'service_charge', 'delivery_charge', 'classroom_charge', 'binding_charge', 'printing_amount', 'ticket_access_token_hash', 'grossExtraRevenue', 'customerTotal'];

const fullRow = {
    id: 7, ticket_number: 'CP-007', status: 'accepted', shop_id: 1, created_at: '2026-10-12T10:00:00Z',
    collection_location_id: 'hostel-gate', collection_location: 'Hostel Gate', collection_time: '1:15 PM',
    guest_full_name: 'Student', guest_phone: '9876543210', payment_status: 'PAID', payment_method: 'CASHFREE',
    ticket_status: 'READY', total_price: '37.00', printing_amount: '30.00', service_charge: '3.00',
    delivery_charge: '3.00', classroom_charge: '0.00', binding_charge: '26.00', ticket_access_token_hash: 'f'.repeat(64)
};
const fileRow = { id: 1, order_id: 7, original_name: 'notes.pdf', page_count: 15, copies: 1, printing_side: 'single', color_mode: 'bw', printing_charge: '30.00' };

const originals = {};
function stub(target, name, fn) {
    originals[`${target === Order ? 'Order' : target === Payment ? 'Payment' : 'OrderFile'}.${name}`] = [target, name, target[name]];
    target[name] = fn;
}

let server;
let base;

function findForbidden(value, path = '$') {
    if (Array.isArray(value)) return value.flatMap((v, i) => findForbidden(v, `${path}[${i}]`));
    if (value && typeof value === 'object') {
        return Object.entries(value).flatMap(([k, v]) =>
            (FORBIDDEN_KEYS.includes(k) ? [`${path}.${k}`] : []).concat(findForbidden(v, `${path}.${k}`)));
    }
    return [];
}

before(async () => {
    stub(Order, 'getDashboardStats', async (shopId, opts) => ({
        totalOrders: 1, earningsToday: opts?.view === 'printing' ? 30 : 37, totalEarnings: 30, recentOrders: [{ ...fullRow }]
    }));
    stub(Order, 'listOrders', async () => ({ orders: [{ ...fullRow }], total: 1, page: 1, limit: 20 }));
    stub(Order, 'getOrderById', async () => ({ ...fullRow }));
    stub(Order, 'updateStatus', async () => ({ order: { ...fullRow } }));
    stub(Order, 'getEarnings', async () => ({ total: { amount: 30, count: 1 }, recentTransactions: [{ id: 7, amount: 30 }] }));
    stub(OrderFile, 'getFilesByOrder', async () => [{ ...fileRow }]);
    stub(Payment, 'findByOrderId', async () => ({ status: 'success', method: 'cashfree', transaction_ref: 'cf-1', amount: '37.00' }));
    stub(Payment, 'refundForOrder', async () => {});
    stub(Payment, 'listPrinterPayables', async () => ({ payments: [{ id: 1, order_id: 7, status: 'success', amount: 30 }], total: 1 }));

    const app = express();
    app.use(express.json());
    // A logged-in PRINTER ADMIN session (no super-admin role).
    app.use((req, res, next) => {
        req.session = { adminId: 2, adminRole: 'shop_admin', adminShopId: 1 };
        next();
    });
    app.use('/api/admin', require('../routes/admin'));
    app.use('/api/super-admin', require('../routes/superAdmin'));
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    for (const [target, name, fn] of Object.values(originals)) target[name] = fn;
    await new Promise(resolve => server.close(resolve));
});

describe('Printer Admin responses carry printing charges only', () => {
    const endpoints = [
        ['GET', '/api/admin/dashboard'],
        ['GET', '/api/admin/orders'],
        ['GET', '/api/admin/orders/7'],
        ['GET', '/api/admin/earnings'],
        ['GET', '/api/admin/transactions'],
        ['POST', '/api/admin/orders/7/accept'],
        ['POST', '/api/admin/orders/7/reject'],
        ['PATCH', '/api/admin/orders/7/status', { status: 'printing' }]
    ];
    for (const [method, path, body] of endpoints) {
        it(`${method} ${path}`, async () => {
            const res = await fetch(base + path, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: body ? JSON.stringify(body) : undefined
            });
            assert.equal(res.status, 200);
            const json = await res.json();
            assert.deepEqual(findForbidden(json), [], `money fields leaked from ${path}`);
        });
    }

    it('order detail shows the printer payable and per-file printing charges', async () => {
        const json = await (await fetch(`${base}/api/admin/orders/7`)).json();
        assert.equal(json.printer_payable, 55);
        assert.equal(json.printing_subtotal, 30);
        assert.equal(json.binding_amount, 25);
        assert.equal(json.files[0].printing_charge, 30);
        assert.equal(json.files[0].printing_category, 'BW_SINGLE');
    });
});

describe('Printer Admin is refused by owner-only endpoints', () => {
    const blocked = [
        ['GET', '/api/super-admin/financials'],
        ['GET', '/api/super-admin/orders'],
        ['GET', '/api/super-admin/orders/7'],
        ['POST', '/api/super-admin/orders/7/mark-paid'],
        ['GET', '/api/super-admin/transactions'],
        ['GET', '/api/super-admin/analytics']
    ];
    for (const [method, path] of blocked) {
        it(`${method} ${path} → 401`, async () => {
            const res = await fetch(base + path, { method });
            assert.equal(res.status, 401);
        });
    }

    it('there is no printer mark-paid route any more', async () => {
        const res = await fetch(`${base}/api/admin/orders/7/mark-paid`, { method: 'POST' });
        assert.equal(res.status, 404);
    });
});
