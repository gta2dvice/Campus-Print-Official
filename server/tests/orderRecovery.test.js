const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const express = require('express');
const session = require('express-session');
const pool = require('../db');
const Order = require('../models/Order');
const RecoveryOtp = require('../models/RecoveryOtp');
const emailService = require('../services/emailService');
const otpService = require('../services/otp');
const ordersRouter = require('../routes/orders');
const { normalizeEmail, maskEmail } = require('../email');

const originalFetch = global.fetch;
const originalPoolQuery = pool.pool.query;
const originalExecute = pool.execute;
const originalTransaction = pool.transaction;
const originalCreateOtp = RecoveryOtp.createOtp;
const originalInvalidateOtp = RecoveryOtp.invalidateOtp;
const originalCleanupExpired = RecoveryOtp.cleanupExpired;
const originalVerifyOtp = RecoveryOtp.verifyOtp;
const originalCheckCooldown = RecoveryOtp.checkCooldown;
const originalGetOrdersByVerifiedEmail = Order.getOrdersByVerifiedEmail;
const originalGetOrderRecord = Order.getOrderRecord;
const originalSendOtp = otpService.sendOtp;
const originalSendEmail = emailService.sendEmail;
const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL
};

after(() => {
    global.fetch = originalFetch;
    pool.pool.query = originalPoolQuery;
    pool.execute = originalExecute;
    pool.transaction = originalTransaction;
    RecoveryOtp.createOtp = originalCreateOtp;
    RecoveryOtp.invalidateOtp = originalInvalidateOtp;
    RecoveryOtp.cleanupExpired = originalCleanupExpired;
    RecoveryOtp.verifyOtp = originalVerifyOtp;
    RecoveryOtp.checkCooldown = originalCheckCooldown;
    Order.getOrdersByVerifiedEmail = originalGetOrdersByVerifiedEmail;
    Order.getOrderRecord = originalGetOrderRecord;
    otpService.sendOtp = originalSendOtp;
    emailService.sendEmail = originalSendEmail;
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

function setResendEnv() {
    process.env.NODE_ENV = 'production';
    process.env.RESEND_API_KEY = 're_test_mock_api_key_12345';
    process.env.RESEND_FROM_EMAIL = 'Campus Print <orders@campusprint.com>';
}

describe('Campus Print email OTP recovery', () => {
    it('normalizes and masks email addresses without leaking sensitive data', () => {
        assert.equal(normalizeEmail('  Student.One@University.Edu  '), 'student.one@university.edu');
        assert.equal(normalizeEmail('invalid-email'), null);
        assert.equal(normalizeEmail(''), null);
        assert.equal(normalizeEmail(null), null);

        assert.equal(maskEmail('student@university.edu'), 's***t@university.edu');
        assert.equal(maskEmail('me@domain.com'), 'm*@domain.com');
        assert.equal(maskEmail('a@b.com'), 'a*@b.com');
        assert.equal(maskEmail('invalid'), '****');
    });

    it('stores only HMACed codes, enforces 5-minute expiry, locks after 5 attempts, and consumes once', async () => {
        const original = pool.transaction;
        const statements = [];
        let activeRecord;
        pool.transaction = async callback => callback({
            async execute(sql, params) {
                statements.push({ sql, params });
                if (/INSERT INTO order_recovery_otps/i.test(sql)) {
                    activeRecord = {
                        id: 42,
                        email: params[0],
                        otp_hash: params[1],
                        expires_at: params[2],
                        attempts: 0
                    };
                    return [{ insertId: activeRecord.id }];
                } else if (/attempts =/i.test(sql)) {
                    activeRecord.attempts = params[0];
                } else if (/consumed_at = NOW\(\).*WHERE id/i.test(sql)) {
                    activeRecord.consumed_at = true;
                }
                return [{}];
            },
            async query() {
                return [activeRecord && !activeRecord.consumed_at ? [activeRecord] : []];
            }
        });

        try {
            const email = 'student@campus.edu';
            assert.equal(RecoveryOtp.OTP_TTL_MS, 5 * 60 * 1000);
            assert.equal(RecoveryOtp.MAX_VERIFY_ATTEMPTS, 5);

            const created = await RecoveryOtp.createOtp(email);
            const otp = created.otp;
            assert.equal(created.id, 42);
            assert.match(statements[0].sql, /consumed_at = NOW\(\)/);
            assert.match(statements[1].sql, /INSERT INTO order_recovery_otps/);
            assert.equal(activeRecord.otp_hash, otpService.hashOtp(otp, email));
            assert.notEqual(activeRecord.otp_hash, otp, 'Plaintext OTP must never be stored');

            // 1 wrong attempt
            const attempt1 = await RecoveryOtp.verifyOtp(email, '000000');
            assert.equal(attempt1.ok, false);
            assert.equal(attempt1.reason, 'mismatch');
            assert.equal(attempt1.attemptsLeft, 4);

            // 4 more wrong attempts -> locks challenge
            for (let i = 0; i < 3; i++) {
                await RecoveryOtp.verifyOtp(email, '000000');
            }
            const lockedAttempt = await RecoveryOtp.verifyOtp(email, '000000');
            assert.equal(lockedAttempt.ok, false);
            assert.equal(lockedAttempt.reason, 'locked');

            // Even the correct code cannot be used once locked
            const afterLock = await RecoveryOtp.verifyOtp(email, otp);
            assert.equal(afterLock.ok, false);
            assert.equal(afterLock.reason, 'locked');

            // Fresh OTP challenge
            activeRecord = {
                id: 43,
                email,
                otp_hash: otpService.hashOtp(otp, email),
                attempts: 0
            };
            const validResult = await RecoveryOtp.verifyOtp(email, otp);
            assert.equal(validResult.ok, true);
            assert.equal(activeRecord.consumed_at, true);

            // Single use: cannot be verified again after consumption
            const reusedResult = await RecoveryOtp.verifyOtp(email, otp);
            assert.equal(reusedResult.ok, false);
            assert.equal(reusedResult.reason, 'expired');
        } finally {
            pool.transaction = original;
        }
    });

    it('sends branded emails through Resend, enforces security notices, and handles delivery failures cleanly', async () => {
        setResendEnv();
        let sentPayload = null;
        emailService.sendEmail = async payload => {
            sentPayload = payload;
            return { delivered: true, messageId: 'msg_test_123', provider: 'resend' };
        };

        const result = await otpService.sendOtp('student@campus.edu', '654321');
        assert.equal(result.delivered, true);
        assert.equal(result.provider, 'resend');
        assert.equal(sentPayload.to, 'student@campus.edu');
        assert.match(sentPayload.subject, /654321/);
        assert.match(sentPayload.html, /654321/);
        assert.match(sentPayload.html, /5 minutes/);
        assert.match(sentPayload.html, /Do not share this code/);
        assert.match(sentPayload.text, /654321/);
        assert.match(sentPayload.text, /(will expire|expires) in 5 minutes/i);

        // When RESEND_API_KEY is not configured in production
        delete process.env.RESEND_API_KEY;
        await assert.rejects(otpService.sendOtp('student@campus.edu', '654321'), err => {
            assert.equal(err.code, 'OTP_PROVIDER_NOT_CONFIGURED');
            assert.equal(err.status, 503);
            return true;
        });

        // Provider rate limit error
        setResendEnv();
        emailService.sendEmail = async () => {
            const err = new emailService.EmailDeliveryError(
                'EMAIL_PROVIDER_RATE_LIMITED',
                429,
                'Too many email requests. Please wait a moment before trying again.'
            );
            throw err;
        };
        await assert.rejects(otpService.sendOtp('student@campus.edu', '654321'), err => {
            assert.equal(err.code, 'EMAIL_PROVIDER_RATE_LIMITED');
            assert.equal(err.status, 429);
            return true;
        });

        // Network failure
        emailService.sendEmail = async () => {
            const err = new emailService.EmailDeliveryError(
                'EMAIL_PROVIDER_UNAVAILABLE',
                503,
                'We could not reach the email service. Please try again shortly.'
            );
            throw err;
        };
        await assert.rejects(otpService.sendOtp('student@campus.edu', '654321'), err => {
            assert.equal(err.code, 'EMAIL_PROVIDER_UNAVAILABLE');
            assert.equal(err.status, 503);
            return true;
        });
    });

    it('handles full HTTP recovery flow: validation, rate limiting, cooldown, verification, history, ticket access, and logout', async t => {
        setResendEnv();
        const rateCounts = new Map();
        pool.pool.query = async (_sql, params) => {
            const bucket = params[0];
            const count = (rateCounts.get(bucket) || 0) + 1;
            rateCounts.set(bucket, count);
            return { rows: [{ count }] };
        };

        let invalidatedId = null;
        let cooldownActive = false;
        RecoveryOtp.checkCooldown = async () => {
            if (cooldownActive) return { inCooldown: true, remainingSeconds: 45 };
            return { inCooldown: false, remainingSeconds: 0 };
        };
        RecoveryOtp.createOtp = async () => ({ id: 99, otp: '889900' });
        RecoveryOtp.invalidateOtp = async id => { invalidatedId = id; };
        RecoveryOtp.cleanupExpired = async () => {};
        RecoveryOtp.verifyOtp = async (email, otp) => {
            if (otp === '889900') return { ok: true };
            return { ok: false, reason: 'mismatch', attemptsLeft: 4 };
        };

        const testOrders = [
            {
                id: 101,
                guest_email: 'student@example.com',
                ticket_number: 'CP-101',
                payment_status: 'PAID',
                payment_method: 'CASHFREE',
                ticket_status: 'READY',
                status: 'completed',
                latest_payment_status: 'success',
                latest_payment_method: 'cashfree',
                latest_gateway_order_id: 'cf_101',
                total_price: '35.00',
                collection_location: 'Library Desk',
                collection_time: '2:00 PM',
                collection_date: '2026-10-18',
                file_count: 1
            },
            {
                id: 102,
                guest_email: 'student@example.com',
                ticket_number: null,
                payment_status: 'PAYMENT_PENDING',
                payment_method: 'CASHFREE',
                ticket_status: 'PENDING_PAYMENT',
                status: 'pending',
                latest_payment_status: 'pending',
                latest_payment_method: 'cashfree',
                latest_gateway_order_id: 'cf_102',
                total_price: '50.00',
                collection_location: 'Hostel Gate',
                collection_time: '4:00 PM',
                collection_date: '2026-10-18',
                file_count: 2
            }
        ];

        Order.getOrdersByVerifiedEmail = async email => {
            assert.equal(email, 'student@example.com');
            return testOrders;
        };

        Order.getOrderRecord = async id => {
            const numId = Number(id);
            if (numId === 101) return testOrders[0];
            if (numId === 999) {
                // Another student's order
                return {
                    id: 999,
                    guest_email: 'other@example.com',
                    ticket_number: 'CP-999',
                    payment_status: 'PAID',
                    ticket_status: 'READY'
                };
            }
            if (numId === 500) {
                // Historical legacy order without email
                return {
                    id: 500,
                    guest_email: null,
                    guest_phone: '9876543210',
                    ticket_number: 'CP-500',
                    payment_status: 'PAID',
                    ticket_status: 'READY',
                    ticket_access_token_hash: null
                };
            }
            return null;
        };

        const app = express();
        app.use(express.json());
        app.use(session({
            secret: 'test-session-secret',
            resave: false,
            saveUninitialized: false
        }));
        app.use('/api/orders', ordersRouter);

        const server = app.listen(0);
        t.after(() => new Promise(resolve => server.close(resolve)));
        await new Promise(resolve => server.once('listening', resolve));
        const baseUrl = `http://127.0.0.1:${server.address().port}`;

        // 1. Rejects invalid email
        const invalidRes = await fetch(`${baseUrl}/api/orders/lookup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'notanemail' })
        });
        assert.equal(invalidRes.status, 400);
        assert.equal((await invalidRes.json()).code, 'INVALID_EMAIL');

        // 2. Email delivery failure -> safe 503 and invalidates stored challenge
        otpService.sendOtp = async () => {
            const err = new Error('Resend network timeout');
            err.code = 'OTP_PROVIDER_UNAVAILABLE';
            err.status = 503;
            throw err;
        };
        const deliveryFailRes = await fetch(`${baseUrl}/api/orders/lookup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'student@example.com' })
        });
        assert.equal(deliveryFailRes.status, 503);
        assert.equal((await deliveryFailRes.json()).code, 'OTP_PROVIDER_UNAVAILABLE');
        assert.equal(invalidatedId, 99);

        // 3. Successful lookup
        otpService.sendOtp = async () => ({ delivered: true, devOtp: null, provider: 'resend' });
        const lookupRes = await fetch(`${baseUrl}/api/orders/lookup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'student@example.com' })
        });
        const lookupData = await lookupRes.json();
        assert.equal(lookupRes.status, 200);
        assert.equal(lookupData.emailMasked, 's***t@example.com');
        assert.equal(lookupData.cooldownSeconds, 60);

        // 4. Resend cooldown blocks rapid re-requests
        cooldownActive = true;
        const cooldownRes = await fetch(`${baseUrl}/api/orders/lookup`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'student@example.com' })
        });
        assert.equal(cooldownRes.status, 429);
        assert.equal((await cooldownRes.json()).code, 'RESEND_COOLDOWN');
        cooldownActive = false;

        // 5. Unauthenticated order and history access are refused
        const unauthHistory = await fetch(`${baseUrl}/api/orders/history`);
        assert.equal(unauthHistory.status, 401);
        assert.equal((await unauthHistory.json()).code, 'RECOVERY_SESSION_REQUIRED');

        const unauthTicket = await fetch(`${baseUrl}/api/orders/101`);
        assert.equal(unauthTicket.status, 404);

        // 6. Verify OTP: incorrect code returns 400
        const wrongVerify = await fetch(`${baseUrl}/api/orders/verify-recovery`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'student@example.com', otp: '111111' })
        });
        assert.equal(wrongVerify.status, 400);

        // 7. Verify OTP: correct code returns 200 and establishes session cookie
        const validVerify = await fetch(`${baseUrl}/api/orders/verify-recovery`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'student@example.com', otp: '889900' })
        });
        assert.equal(validVerify.status, 200);
        const cookie = validVerify.headers.get('set-cookie')?.split(';')[0];
        assert.ok(cookie, 'Cookie must be present');

        // 8. Order history returned for verified email
        const historyRes = await fetch(`${baseUrl}/api/orders/history`, {
            headers: { cookie }
        });
        assert.equal(historyRes.status, 200);
        const historyData = await historyRes.json();
        assert.equal(historyData.emailMasked, 's***t@example.com');
        assert.equal(historyData.orders.length, 2);
        assert.equal(historyData.orders[0].orderId, 101);
        assert.equal(historyData.orders[0].paymentStatus, 'PAID');
        assert.equal(historyData.orders[0].state, 'TICKET_READY');
        assert.equal(historyData.orders[1].orderId, 102);
        assert.equal(historyData.orders[1].paymentStatus, 'PAYMENT_PENDING');

        // 9. Viewing own ticket succeeds
        const ticketRes = await fetch(`${baseUrl}/api/orders/101`, {
            headers: { cookie }
        });
        assert.equal(ticketRes.status, 200);

        // 10. Attempting to view another user's order is refused (404)
        const otherTicketRes = await fetch(`${baseUrl}/api/orders/999`, {
            headers: { cookie }
        });
        assert.equal(otherTicketRes.status, 404);

        // 11. Historical order without email is refused via email recovery (must use ticket token)
        const legacyTicketRes = await fetch(`${baseUrl}/api/orders/500`, {
            headers: { cookie }
        });
        assert.equal(legacyTicketRes.status, 404);

        // 12. Logout / end recovery session
        const logoutRes = await fetch(`${baseUrl}/api/orders/logout-recovery`, {
            method: 'POST',
            headers: { cookie }
        });
        assert.equal(logoutRes.status, 200);

        // After logout, session is revoked
        const postLogoutHistory = await fetch(`${baseUrl}/api/orders/history`, {
            headers: { cookie }
        });
        assert.equal(postLogoutHistory.status, 401);

        Order.getOrdersByVerifiedEmail = originalGetOrdersByVerifiedEmail;
        Order.getOrderRecord = originalGetOrderRecord;
        otpService.sendOtp = originalSendOtp;
        RecoveryOtp.verifyOtp = originalVerifyOtp;
        RecoveryOtp.createOtp = originalCreateOtp;
    });

    it('queries guest and user orders matching verified email including payment status', async () => {
        const original = pool.execute;
        let capturedQuery;
        pool.execute = async (sql, params) => {
            capturedQuery = { sql, params };
            return [[{ id: 101, payment_status: 'PAID', guest_email: 'student@example.com' }]];
        };

        try {
            const results = await Order.getOrdersByVerifiedEmail('Student@Example.COM');
            assert.equal(results.length, 1);
            assert.match(capturedQuery.sql, /o\.guest_email/);
            assert.match(capturedQuery.sql, /u\.email/);
            assert.match(capturedQuery.sql, /LEFT JOIN users/);
            assert.match(capturedQuery.sql, /LEFT JOIN LATERAL/);
            assert.deepEqual(capturedQuery.params, ['student@example.com', 'student@example.com']);
        } finally {
            pool.execute = original;
        }
    });
});
