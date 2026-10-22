const assert = require('node:assert/strict');
const { after, beforeEach, describe, it } = require('node:test');
const express = require('express');
const session = require('express-session');
const pool = require('../db');
const { createFakeDb, restoreDb } = require('./helpers/fakeDb');
const { processSuccessfulPayment } = require('../services/paymentFinalizer');
const {
    sendTicketEmail,
    getTicketEmailStatus,
    retryTicketEmail,
    resolveTicketUrl,
    buildTicketEmailHtml,
    buildTicketEmailText
} = require('../services/ticketEmailService');
const { generateTicketPdf } = require('../services/ticketPdfGenerator');
const emailService = require('../services/emailService');
const { PDFDocument } = require('pdf-lib');
const { createTicketToken, hashTicketToken } = require('../ticketTokens');
const ordersRouter = require('../routes/orders');

process.env.TICKET_TOKEN_SECRET = process.env.TICKET_TOKEN_SECRET || 'unit-test-ticket-secret-with-sufficient-entropy';
process.env.RESEND_API_KEY = 're_test_mock_resend_key_12345';
process.env.RESEND_FROM_EMAIL = 'Campus Print <orders@campusprint.com>';
process.env.FRONTEND_URL = 'http://localhost:3000';

let db;
let sentEmails = [];
let resendFailure = null;
async function waitForEmail(targetCount = 1, timeoutMs = 2000) {
    const start = Date.now();
    while (sentEmails.length < targetCount && Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 10));
    }
}

const originalSendEmail = emailService.sendEmail;

beforeEach(() => {
    db = createFakeDb();
    db.install();
    sentEmails = [];
    resendFailure = null;

    emailService.sendEmail = async (options) => {
        if (resendFailure) {
            const err = new Error(resendFailure.message || 'Resend API rejected');
            err.code = resendFailure.code || 'EMAIL_PROVIDER_UNAVAILABLE';
            err.status = resendFailure.status || 503;
            throw err;
        }
        sentEmails.push(options);
        return {
            delivered: true,
            messageId: `msg_${Date.now()}_${sentEmails.length}`,
            provider: 'resend'
        };
    };
});

after(() => {
    restoreDb();
    emailService.sendEmail = originalSendEmail;
});

describe('Automatic Ticket Email Delivery', () => {

    it('1. Successful payment triggers ticket email delivery with PDF and secure link', async () => {
        const orderId = 2001;
        const gatewayOrderId = 'cp_cf_2001';
        const ticketToken = createTicketToken(gatewayOrderId);

        db.addOrder({
            id: orderId,
            total_price: 65,
            guest_full_name: 'Alex Johnson',
            guest_email: 'alex.j@example.edu',
            guest_phone: '9876543210',
            collection_location: 'Hostel Gate',
            collection_time: '11:00 AM - 12:00 PM',
            ticket_access_token_hash: hashTicketToken(ticketToken)
        });

        const payment = db.addPayment({
            order_id: orderId,
            method: 'cashfree',
            amount: 65,
            gateway_order_id: gatewayOrderId
        });

        // Finalize payment
        const result = await processSuccessfulPayment(orderId, {
            paymentId: payment.id,
            method: 'cashfree',
            amount: 65,
            transactionRef: 'CF_TXN_2001',
            source: 'cashfree_webhook'
        });

        assert.equal(result.ticketStatus, 'READY');
        assert.equal(result.ticketNumber, 'CP-2001');
        await waitForEmail(1);

        // Check email sent
        assert.equal(sentEmails.length, 1, 'Expected exactly one email to be sent');
        const email = sentEmails[0];
        assert.equal(email.to, 'alex.j@example.edu');
        assert.equal(email.subject, 'Your Campus Print Ticket — CP-2001');
        assert.ok(email.html.includes('Alex Johnson'));
        assert.ok(email.html.includes('CP-2001'));
        assert.ok(email.html.includes('Hostel Gate'));
        assert.ok(email.html.includes('/ticket?token='));

        // Check PDF attachment
        assert.ok(Array.isArray(email.attachments) && email.attachments.length === 1);
        const attachment = email.attachments[0];
        assert.equal(attachment.filename, 'Campus-Print-Ticket-CP-2001.pdf');
        assert.equal(attachment.contentType, 'application/pdf');
        assert.ok(Buffer.isBuffer(attachment.content));

        // Verify PDF integrity
        const parsedPdf = await PDFDocument.load(attachment.content);
        assert.equal(parsedPdf.getPageCount(), 1);

        // Check outbox status
        const outbox = await getTicketEmailStatus(orderId);
        assert.equal(outbox.status, 'SENT');
        assert.equal(outbox.attempts, 1);
        assert.ok(outbox.sentAt);
    });

    it('2. Unsuccessful or pending payments do not trigger a paid ticket email', async () => {
        const orderId = 2002;
        db.addOrder({
            id: orderId,
            total_price: 40,
            payment_status: 'PAYMENT_PENDING',
            ticket_status: 'PENDING_PAYMENT',
            guest_email: 'pending.student@example.edu'
        });

        const sendResult = await sendTicketEmail(orderId, { source: 'test' });
        assert.equal(sendResult.status, 'SKIPPED');
        assert.equal(sendResult.reason, 'PAYMENT_NOT_PAID');
        assert.equal(sentEmails.length, 0);

        // Failed payment test
        db.orders.get(orderId).payment_status = 'PAYMENT_FAILED';
        const failedResult = await sendTicketEmail(orderId, { source: 'test' });
        assert.equal(failedResult.status, 'SKIPPED');
        assert.equal(failedResult.reason, 'PAYMENT_NOT_PAID');
        assert.equal(sentEmails.length, 0);
    });

    it('3. Resend API failure leaves paid order and ticket intact and allows controlled retry', async () => {
        const orderId = 2003;
        db.addOrder({
            id: orderId,
            total_price: 30,
            payment_status: 'PAID',
            ticket_status: 'READY',
            ticket_number: 'CP-2003',
            guest_email: 'retry.student@example.edu'
        });

        // Simulate Resend 503 error
        resendFailure = { message: 'Resend API rate limit exceeded', code: 'EMAIL_PROVIDER_RATE_LIMITED', status: 429 };

        const sendResult = await sendTicketEmail(orderId, { source: 'test' });
        assert.equal(sendResult.status, 'FAILED');
        assert.equal(sentEmails.length, 0);

        // Crucial: order must still be PAID and ticket must still be READY
        assert.equal(db.orders.get(orderId).payment_status, 'PAID');
        assert.equal(db.orders.get(orderId).ticket_status, 'READY');
        assert.equal(db.orders.get(orderId).ticket_number, 'CP-2003');

        // Outbox tracks failure
        let outbox = await getTicketEmailStatus(orderId);
        assert.equal(outbox.status, 'FAILED');
        assert.equal(outbox.attempts, 1);

        // Now recover Resend and retry
        resendFailure = null;
        const retryResult = await retryTicketEmail(orderId);
        assert.equal(retryResult.status, 'SENT');
        assert.equal(sentEmails.length, 1);

        outbox = await getTicketEmailStatus(orderId);
        assert.equal(outbox.status, 'SENT');
        assert.equal(outbox.attempts, 2);
    });

    it('4. Duplicate webhooks and repeated browser returns do not send duplicate emails', async () => {
        const orderId = 2004;
        const gatewayOrderId = 'cp_cf_2004';
        const ticketToken = createTicketToken(gatewayOrderId);

        db.addOrder({
            id: orderId,
            total_price: 50,
            guest_email: 'student.once@example.edu',
            ticket_access_token_hash: hashTicketToken(ticketToken)
        });

        const payment = db.addPayment({
            order_id: orderId,
            method: 'cashfree',
            amount: 50,
            gateway_order_id: gatewayOrderId
        });

        // Simulate concurrent execution: Webhook and Return Verify called simultaneously
        const [res1, res2, res3] = await Promise.all([
            processSuccessfulPayment(orderId, { paymentId: payment.id, method: 'cashfree', amount: 50, source: 'cashfree_webhook' }),
            processSuccessfulPayment(orderId, { paymentId: payment.id, method: 'cashfree', amount: 50, source: 'return_verify' }),
            processSuccessfulPayment(orderId, { paymentId: payment.id, method: 'cashfree', amount: 50, source: 'status_poll' })
        ]);

        await waitForEmail(1);
        assert.equal(sentEmails.length, 1, 'Only one email must be sent despite concurrent payment verifications');
        assert.equal(db.ticketWrites, 1, 'Only one ticket write allowed');

        // Subsequent call to sendTicketEmail returns alreadySent
        const laterAttempt = await sendTicketEmail(orderId);
        assert.equal(laterAttempt.status, 'SENT');
        assert.equal(laterAttempt.alreadySent, true);
        assert.equal(sentEmails.length, 1);
    });

    it('5. Correct recipient selection (guest email vs user account email vs no email)', async () => {
        // Case A: Guest email
        const orderA = 2005;
        db.addOrder({ id: orderA, payment_status: 'PAID', ticket_status: 'READY', ticket_number: 'CP-2005', guest_email: 'guest@college.edu' });
        await sendTicketEmail(orderA);
        assert.equal(sentEmails[0].to, 'guest@college.edu');

        // Case B: User email
        const orderB = 2006;
        db.addOrder({ id: orderB, payment_status: 'PAID', ticket_status: 'READY', ticket_number: 'CP-2006', customer_email: 'user@college.edu' });
        await sendTicketEmail(orderB);
        assert.equal(sentEmails[1].to, 'user@college.edu');

        // Case C: No email (legacy order)
        const orderC = 2007;
        db.addOrder({ id: orderC, payment_status: 'PAID', ticket_status: 'READY', ticket_number: 'CP-2007', guest_email: null, customer_email: null });
        const noEmailResult = await sendTicketEmail(orderC);
        assert.equal(noEmailResult.status, 'SKIPPED');
        assert.equal(noEmailResult.reason, 'NO_RECIPIENT_EMAIL');
        assert.equal(sentEmails.length, 2); // No new email sent
    });

    it('6. PDF ticket and secure links do not expose sensitive student files', async () => {
        const order = {
            id: 2008,
            ticket_number: 'CP-2008',
            guest_full_name: 'Charlie Brown',
            guest_phone: '9988776655',
            guest_classroom: 'Room 302',
            collection_location: 'Academic Block',
            collection_time: '2:00 PM',
            total_price: 80,
            file_count: 2,
            total_pages: 20
        };

        const pdfBuffer = await generateTicketPdf(order);
        assert.ok(Buffer.isBuffer(pdfBuffer));

        const html = buildTicketEmailHtml({
            order,
            ticketNumber: 'CP-2008',
            ticketUrl: 'https://campusprint.com/ticket?token=secret123',
            transactionRef: 'CF_12345'
        });

        // Ensure ticket link is present
        assert.ok(html.includes('https://campusprint.com/ticket?token=secret123'));
        // Ensure student private file storage path or internal tokens are not leaked
        assert.ok(!html.includes('uploaded-pdfs/'));
        assert.ok(!html.includes('storage_path'));
        assert.ok(!html.includes('RESEND_API_KEY'));
    });

    it('escapes customer-controlled fields in ticket email HTML', () => {
        const html = buildTicketEmailHtml({
            order: {
                id: 2010,
                guest_full_name: '<img src=x onerror=alert(1)>',
                collection_location: '</td><script>alert(1)</script>',
                collection_time: '10:00 & 11:00',
                ticket_number: 'CP-2010'
            },
            ticketNumber: 'CP-2010',
            ticketUrl: 'https://campusprint.com/ticket?token=abc&next=home',
            transactionRef: '<script>alert(1)</script>'
        });

        assert.ok(!html.includes('<img'));
        assert.ok(!html.includes('<script>'));
        assert.ok(html.includes('&lt;img'));
        assert.ok(html.includes('&lt;script&gt;'));
        assert.ok(html.includes('token=abc&amp;next=home'));
    });

    it('7. Ticket availability when email delivery fails (HTTP endpoint check)', async () => {
        const orderId = 2009;
        const gatewayOrderId = 'cp_cf_2009';
        const ticketToken = createTicketToken(gatewayOrderId);

        db.addOrder({
            id: orderId,
            total_price: 30,
            payment_status: 'PAID',
            ticket_status: 'READY',
            ticket_number: 'CP-2009',
            guest_email: 'test@example.com',
            ticket_access_token_hash: hashTicketToken(ticketToken)
        });

        // Setup Express app to test routes
        const app = express();
        app.use(express.json());
        app.use(session({ secret: 'test-secret', resave: false, saveUninitialized: true }));
        app.use('/api/orders', ordersRouter);

        const server = app.listen(0);
        const { port } = server.address();
        const baseUrl = `http://127.0.0.1:${port}`;

        try {
            // First simulate email failed state
            resendFailure = { message: 'Out of credits' };
            await sendTicketEmail(orderId);

            const outbox = await getTicketEmailStatus(orderId);
            assert.equal(outbox.status, 'FAILED');

            // Now student accesses their ticket via secure token
            const res = await fetch(`${baseUrl}/api/orders/ticket/${ticketToken}`);
            assert.equal(res.status, 200);
            const body = await res.json();

            // Ticket MUST be fully available
            assert.equal(body.ticket_number, 'CP-2009');
            assert.equal(body.payment_status, 'PAID');
            assert.equal(body.emailDelivery.status, 'FAILED');

            // Student clicks retry email on ticket page
            resendFailure = null;
            const retryRes = await fetch(`${baseUrl}/api/orders/ticket/${ticketToken}/retry-email`, {
                method: 'POST'
            });
            assert.equal(retryRes.status, 200);
            const retryBody = await retryRes.json();
            assert.equal(retryBody.success, true);
            assert.equal(retryBody.emailDelivery.status, 'SENT');
        } finally {
            await new Promise(resolve => server.close(resolve));
        }
    });
});
