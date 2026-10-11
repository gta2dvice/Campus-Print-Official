// Simplified admin workflow (Pending → Accept → Completed / Ready for Pickup) and
// admin / super-admin file preview + download.
// Run: node --test server/tests/
const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

// Stub storage BEFORE the routes load (sendStoredFile binds downloadFile at require time).
const storage = require('../storage');
const STORED = { 'guest/7/abc.pdf': Buffer.from('%PDF-1.4 test file bytes') };
storage.downloadFile = async (path) => {
    if (!STORED[path]) {
        const error = new Error('Object not found');
        error.statusCode = 404;
        throw error;
    }
    return STORED[path];
};

const express = require('express');
const pool = require('../db');
const Order = require('../models/Order');
const OrderFile = require('../models/OrderFile');
const Payment = require('../models/Payment');

// ── In-memory orders table understood by Order.updateStatus / getOrderById ──
let orders;
const originalExecute = pool.execute;
function installFakeOrders() {
    pool.execute = async (sql, params = []) => {
        const s = sql.replace(/\s+/g, ' ');
        if (/FROM orders o LEFT JOIN users u/.test(s) && /WHERE o\.id = \?/.test(s)) {
            const row = orders.get(Number(params[0]));
            return [row ? [{ ...row }] : []];
        }
        const update = /^ ?UPDATE orders SET status = \?, rejection_reason = \? WHERE id = \? AND status = \?( AND payment_status = 'PAID')?/.exec(s);
        if (update) {
            const [status, reason, id, expected] = params;
            const row = orders.get(Number(id));
            if (!row || row.status !== expected || (update[1] && row.payment_status !== 'PAID')) return [[], { rowCount: 0 }];
            row.status = status;
            row.rejection_reason = reason;
            return [[], { rowCount: 1 }];
        }
        assert.fail(`unexpected SQL: ${s}`);
    };
}

describe('Order.updateStatus — simplified workflow', () => {
    beforeEach(() => {
        orders = new Map([
            [1, { id: 1, status: 'pending', payment_status: 'PAID', rejection_reason: null }],
            [2, { id: 2, status: 'pending', payment_status: 'PAYMENT_PENDING', rejection_reason: null }],
            [3, { id: 3, status: 'printing', payment_status: 'PAID', rejection_reason: null }]
        ]);
        installFakeOrders();
    });
    after(() => { pool.execute = originalExecute; });

    it('Accept moves a paid pending order straight to completed', async () => {
        const result = await Order.updateStatus(1, 'completed');
        assert.equal(result.order.status, 'completed');
        assert.equal(orders.get(1).payment_status, 'PAID');
    });

    it('the removed intermediate steps are no longer allowed', async () => {
        for (const step of ['accepted', 'printing', 'ready']) {
            const result = await Order.updateStatus(1, step);
            assert.equal(result.error, 'invalid_transition', step);
        }
        assert.equal(orders.get(1).status, 'pending');
    });

    it('an unpaid order cannot be accepted and is never marked paid', async () => {
        const result = await Order.updateStatus(2, 'completed');
        assert.equal(result.error, 'payment_pending');
        assert.deepEqual([orders.get(2).status, orders.get(2).payment_status], ['pending', 'PAYMENT_PENDING']);
    });

    it('repeated / concurrent Accept clicks apply once; the rest are refused', async () => {
        const results = await Promise.all(Array.from({ length: 5 }, () => Order.updateStatus(1, 'completed')));
        assert.equal(results.filter(r => r.order).length, 1);
        assert.ok(results.filter(r => r.error).every(r => r.error === 'invalid_transition' && r.from === 'completed'));
    });

    it('a completed order cannot be rejected afterwards', async () => {
        await Order.updateStatus(1, 'completed');
        assert.equal((await Order.updateStatus(1, 'rejected', 'late')).error, 'invalid_transition');
    });

    it('reject keeps the reason; a legacy in-between order can still be completed', async () => {
        assert.equal((await Order.updateStatus(1, 'rejected', 'Blank pages')).order.rejection_reason, 'Blank pages');
        assert.equal((await Order.updateStatus(3, 'completed')).order.status, 'completed');
    });
});

describe('admin + super admin routes over HTTP', () => {
    let server;
    let base;
    let role;
    const stubs = [];
    function stub(target, name, fn) { stubs.push([target, name, target[name]]); target[name] = fn; }

    before(async () => {
        const row = { id: 7, status: 'pending', payment_status: 'PAID', shop_id: 1 };
        stub(Order, 'getOrderById', async (id) => (Number(id) === 7 ? { ...row } : null));
        stub(Order, 'updateStatus', async (id, status) => ({ order: { ...row, status } }));
        stub(Payment, 'refundForOrder', async () => {});
        stub(OrderFile, 'getFileById', async (id) => ({
            1: { id: 1, order_id: 7, original_name: 'my notes – final.pdf', mime_type: 'application/pdf', storage_path: 'guest/7/abc.pdf' },
            2: { id: 2, order_id: 7, original_name: 'old.pdf', mime_type: 'application/pdf', storage_path: null, file_deleted_at: '2026-10-01' },
            3: { id: 3, order_id: 7, original_name: 'lost.pdf', mime_type: 'application/pdf', storage_path: 'guest/7/missing.pdf' },
            4: { id: 4, order_id: 99, original_name: 'other.pdf', mime_type: 'application/pdf', storage_path: 'guest/99/x.pdf' }
        })[id] || null);

        const app = express();
        app.use(express.json());
        app.use((req, res, next) => {
            req.session = role === 'super'
                ? { superAdminId: 1, superAdminRole: 'super_admin' }
                : { adminId: 2, adminRole: 'shop_admin', adminShopId: 1 };
            next();
        });
        app.use('/api/admin', require('../routes/admin'));
        app.use('/api/super-admin', require('../routes/superAdmin'));
        await new Promise(resolve => { server = app.listen(0, resolve); });
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        for (const [target, name, fn] of stubs) target[name] = fn;
        await new Promise(resolve => server.close(resolve));
    });

    for (const who of ['admin', 'super']) {
        const prefix = who === 'super' ? '/api/super-admin' : '/api/admin';

        it(`${who}: preview streams the stored file inline with its real name`, async () => {
            role = who;
            const res = await fetch(`${base}${prefix}/orders/7/documents/1`);
            assert.equal(res.status, 200);
            assert.equal(res.headers.get('content-type'), 'application/pdf');
            assert.match(res.headers.get('content-disposition'), /^inline; filename="my notes _ final\.pdf"; filename\*=UTF-8''my%20notes%20%E2%80%93%20final\.pdf$/);
            assert.equal(Buffer.from(await res.arrayBuffer()).toString(), '%PDF-1.4 test file bytes');
        });

        it(`${who}: download sends it as an attachment`, async () => {
            role = who;
            const res = await fetch(`${base}${prefix}/orders/7/documents/1?download=1`);
            assert.equal(res.status, 200);
            assert.match(res.headers.get('content-disposition'), /^attachment;/);
        });

        it(`${who}: deleted and missing files return clear messages`, async () => {
            role = who;
            const deleted = await fetch(`${base}${prefix}/orders/7/documents/2`);
            assert.equal(deleted.status, 410);
            assert.match((await deleted.json()).message, /deleted from storage/);
            const missing = await fetch(`${base}${prefix}/orders/7/documents/3`);
            assert.equal(missing.status, 404);
            assert.match((await missing.json()).message, /missing from storage/);
        });

        it(`${who}: a file from another order is refused`, async () => {
            role = who;
            const res = await fetch(`${base}${prefix}/orders/7/documents/4`);
            assert.equal(res.status, 404);
        });

        it(`${who}: Accept moves the order to completed`, async () => {
            role = who;
            const res = await fetch(`${base}${prefix}/orders/7/accept`, { method: 'POST' });
            assert.equal(res.status, 200);
            assert.equal((await res.json()).status, 'completed');
        });
    }

    it('super admin can reject a pending order', async () => {
        role = 'super';
        const res = await fetch(`${base}/api/super-admin/orders/7/reject`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'Unreadable' })
        });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).status, 'rejected');
    });

    it('the printer cannot use the super-admin accept route', async () => {
        role = 'admin';
        const res = await fetch(`${base}/api/super-admin/orders/7/accept`, { method: 'POST' });
        assert.equal(res.status, 401);
    });
});

describe('automatic file deletion is off', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.join(__dirname, '..', '..');

    it('no Vercel cron and no cleanup timer in the server', () => {
        const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
        assert.equal(vercel.crons, undefined);
        const serverJs = fs.readFileSync(path.join(root, 'server', 'server.js'), 'utf8');
        assert.ok(!/cleanupExpiredPdfs\(/.test(serverJs));
    });
});
