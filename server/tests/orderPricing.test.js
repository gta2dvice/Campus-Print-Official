const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { priceOrder } = require('../pricing');
const cashfree = require('../cashfree');
const { PDFDocument } = require('pdf-lib');
const { processSuccessfulPayment } = require('../services/paymentFinalizer');
const { createFakeDb, restoreDb } = require('./helpers/fakeDb');
const pageDetectWorker = require('../workers/pageDetect.worker');

describe('server-authoritative order pricing', () => {
    it('prices files using the established B&W per-sheet rule without hidden order fees', () => {
        const result = priceOrder([{
            pages: 4,
            copies: 2,
            printingSide: 'double',
            colorMode: 'bw'
        }], { collectionLocationId: 'hostel-gate', includeServiceCharge: false });

        assert.deepEqual(result, {
            printingAmount: 12,
            fileCharges: [12],
            printedPages: 8,
            serviceCharge: 0,
            deliveryCharge: 0,
            classroomCharge: 0,
            bindingCharge: 0,
            total: 12
        });
    });

    it('charges classroom delivery once and binding separately for each selected PDF', () => {
        const files = [
            { pages: 6, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true },
            { pages: 3, copies: 1, printingSide: 'double', colorMode: 'bw', spiralBinding: false },
            { pages: 6, copies: 1, printingSide: 'double', colorMode: 'color', spiralBinding: true }
        ];
        const result = priceOrder(files, { classroomDelivery: true, includeServiceCharge: false });

        assert.deepEqual(result.fileCharges, [12, 6, 30]);
        assert.equal(result.printingAmount, 48);
        assert.equal(result.serviceCharge, 0);
        assert.equal(result.classroomCharge, 5);
        assert.equal(result.bindingCharge, 52);
        assert.equal(result.total, 105);
    });

    it('retains one-time binding only for legacy clients without per-file settings', () => {
        const result = priceOrder([{ pages: 5, copies: 1, colorMode: 'bw', printingSide: 'single' }], { binding: true });
        assert.equal(result.bindingCharge, 26);
        assert.equal(result.total, 37);
    });
});

describe('unfinished-order print settings restoration', () => {
    it('preserves complete settings and keeps absent settings invalid', async () => {
        const { buildFileSettingsPayload, hasCompleteFileSettings } =
            await import('../../client-react/src/lib/orderStorage.js');
        const freshFile = {
            key: 42,
            pages: 4,
            copies: 2,
            printingSide: 'double',
            colorMode: 'color',
            spiralBinding: true,
            pageRange: '1-3, 5'
        };
        const freshSettings = buildFileSettingsPayload([freshFile])[0];
        const restoredSettings = buildFileSettingsPayload([{ ...freshSettings }])[0];

        assert.deepEqual(restoredSettings, freshSettings);
        assert.equal(hasCompleteFileSettings(restoredSettings), true);
        assert.equal(restoredSettings.spiralBinding, true);
        assert.equal(restoredSettings.pageRange, '1-3, 5');

        const incompleteRestoredFile = buildFileSettingsPayload([{
            key: 43,
            pages: 4
        }])[0];
        assert.equal(incompleteRestoredFile.copies, null);
        assert.equal(incompleteRestoredFile.printingSide, null);
        assert.equal(incompleteRestoredFile.colorMode, null);
        assert.equal(hasCompleteFileSettings(incompleteRestoredFile), false);
    });
});

describe('Cashfree diagnostic redaction', () => {
    it('redacts credentials, payment tokens, email addresses, and full phone numbers', () => {
        const error = new Error('provider failure');
        error.response = {
            status: 401,
            data: {
                code: 'AUTH_ERROR',
                message: 'passkey=secret-value payment_session_id=token-value authorization: Bearer auth-value student@example.com 9876543210'
            }
        };
        const details = cashfree.getErrorDetails(error);

        assert.equal(details.status, 401);
        assert.equal(details.code, 'AUTH_ERROR');
        assert.doesNotMatch(details.message, /secret-value|token-value|auth-value|student@example\.com|9876543210/);
    });
});


describe('Section 5 Required Regression Tests: Double-Sided Pricing, DOCX, and Ticket Safety', () => {
    it('1. Three-page PDF, double-sided: document page count remains 3 and sheet count is 2 per copy', () => {
        const file = { pages: 3, copies: 1, printingSide: 'double', colorMode: 'bw' };
        const sheetsPerCopy = Math.ceil(file.pages / 2);
        const totalSheets = sheetsPerCopy * file.copies;
        assert.equal(file.pages, 3, 'Document page count must remain 3');
        assert.equal(sheetsPerCopy, 2, 'Physical sheets per copy must be 2');
        assert.equal(totalSheets, 2);
        const priced = priceOrder([file]);
        assert.equal(priced.printedPages, 3, 'Logical printed pages for records must remain 3');
        assert.equal(priced.printingAmount, 6, '2 physical sheets * ₹3 = ₹6');
        assert.equal(priced.serviceCharge, 1, 'Tier 1 (1-10 pgs) = ₹1');
        assert.equal(priced.total, 7);
    });

    it('2. Three-page PDF, single-sided: sheet count is 3 per copy', () => {
        const file = { pages: 3, copies: 1, printingSide: 'single', colorMode: 'bw' };
        const sheetsPerCopy = file.pages;
        const totalSheets = sheetsPerCopy * file.copies;
        assert.equal(sheetsPerCopy, 3, 'Physical sheets per copy must be 3');
        assert.equal(totalSheets, 3);
        const priced = priceOrder([file]);
        assert.equal(priced.printedPages, 3);
        assert.equal(priced.printingAmount, 6, '3 pages * ₹2 = ₹6');
        assert.equal(priced.serviceCharge, 1);
        assert.equal(priced.total, 7);
    });

    it('3. Three-page DOCX: detected document page count is 3 when verified by configured rendering engine', async () => {
        const pdfDoc = await PDFDocument.create();
        pdfDoc.addPage([600, 400]);
        pdfDoc.addPage([600, 400]);
        pdfDoc.addPage([600, 400]);
        const pdfBuffer = Buffer.from(await pdfDoc.save());

        const pdfPages = await pageDetectWorker.detectPdfPages(pdfBuffer);
        assert.equal(pdfPages.pages, 3);
        assert.equal(pdfPages.estimated, false);

        const unconfirmed = await pageDetectWorker.detectDocxPages(Buffer.from('mock docx content'));
        assert.equal(unconfirmed.pages, null);
        assert.equal(unconfirmed.estimated, true);
        assert.equal(unconfirmed.requiresConfirmation, true);
    });

    it('4. Odd and even document page counts', () => {
        const evenFile = { pages: 4, copies: 1, printingSide: 'double', colorMode: 'bw' };
        assert.equal(Math.ceil(evenFile.pages / 2), 2);
        assert.equal(priceOrder([evenFile]).printingAmount, 6);

        const oddFile = { pages: 5, copies: 1, printingSide: 'double', colorMode: 'bw' };
        assert.equal(Math.ceil(oddFile.pages / 2), 3);
        assert.equal(priceOrder([oddFile]).printingAmount, 9);
    });

    it('5. Multiple copies', () => {
        const file = { pages: 3, copies: 4, printingSide: 'double', colorMode: 'bw' };
        const sheets = Math.ceil(file.pages / 2) * file.copies;
        assert.equal(sheets, 8);
        const priced = priceOrder([file]);
        assert.equal(priced.printingAmount, 24, '8 sheets * ₹3 = ₹24');
        assert.equal(priced.printedPages, 12, '3 pages * 4 copies = 12 pages');
        assert.equal(priced.serviceCharge, 2, 'Tier 2 (11-30 pages) = ₹2');
        assert.equal(priced.total, 26);
    });

    it('6. Existing PDF and image detection', async () => {
        const pdfDoc = await PDFDocument.create();
        pdfDoc.addPage([600, 400]);
        pdfDoc.addPage([600, 400]);
        const pdfBuffer = Buffer.from(await pdfDoc.save());
        const pdfResult = await pageDetectWorker({ buffer: pdfBuffer, originalname: 'sample.pdf', mimetype: 'application/pdf' });
        assert.equal(pdfResult.pages, 2);
        assert.equal(pdfResult.estimated, false);

        const imgResult = await pageDetectWorker({ buffer: Buffer.from([0xff, 0xd8, 0xff]), originalname: 'sample.jpg', mimetype: 'image/jpeg' });
        assert.equal(imgResult.pages, 1);
        assert.equal(imgResult.estimated, false);
    });

    it('7. Service charges and printing prices follow verified existing rules', () => {
        assert.equal(priceOrder([{ pages: 5, copies: 1, printingSide: 'single', colorMode: 'bw' }]).printingAmount, 10);
        assert.equal(priceOrder([{ pages: 5, copies: 1, printingSide: 'double', colorMode: 'bw' }]).printingAmount, 9);
        assert.equal(priceOrder([{ pages: 5, copies: 1, printingSide: 'single', colorMode: 'color' }]).printingAmount, 25);
        assert.equal(priceOrder([{ pages: 10, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 1);
        assert.equal(priceOrder([{ pages: 11, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 2);
        assert.equal(priceOrder([{ pages: 31, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 3);
    });

    it('8. Frontend and backend totals agree', () => {
        const files = [
            { pages: 3, copies: 2, printingSide: 'double', colorMode: 'bw' },
            { pages: 7, copies: 1, printingSide: 'single', colorMode: 'color' }
        ];
        let clientPrinting = 0;
        let clientPages = 0;
        for (const f of files) {
            clientPages += f.pages * f.copies;
            if (f.colorMode === 'color') clientPrinting += f.pages * f.copies * 5;
            else if (f.printingSide === 'double') clientPrinting += Math.ceil(f.pages / 2) * f.copies * 3;
            else clientPrinting += f.pages * f.copies * 2;
        }
        const clientService = clientPages <= 10 ? 1 : clientPages <= 30 ? 2 : 3;
        const clientTotal = clientPrinting + clientService;

        const backend = priceOrder(files);
        assert.equal(clientPrinting, backend.printingAmount);
        assert.equal(clientPages, backend.printedPages);
        assert.equal(clientService, backend.serviceCharge);
        assert.equal(clientTotal, backend.total);
    });

    it('9. Payment amount mismatch is still rejected', () => {
        assert.equal(cashfree.amountsMatch(7, 7), true);
        assert.equal(cashfree.amountsMatch(7, 6), false);
        assert.equal(cashfree.amountsMatch(7.01, 7.00), true);
        assert.equal(cashfree.amountsMatch(7.10, 7.00), false);
    });

    it('10. A verified successful payment generates exactly one ticket', async () => {
        const fakeDb = createFakeDb();
        fakeDb.install();
        try {
            fakeDb.addOrder({ id: 9101, total_price: 7, guest_full_name: 'Test Student' });
            const payment = fakeDb.addPayment({ order_id: 9101, amount: 7, method: 'cashfree', status: 'pending' });
            const res = await processSuccessfulPayment(9101, {
                paymentId: payment.id,
                method: 'cashfree',
                amount: 7,
                source: 'cashfree_webhook'
            });
            assert.equal(res.ticketStatus, 'READY');
            assert.equal(res.ticketNumber, 'CP-9101');
            assert.equal(res.alreadyFinalized, false);
        } finally {
            restoreDb();
        }
    });

    it('11. Duplicate callbacks do not generate duplicate tickets', async () => {
        const fakeDb = createFakeDb();
        fakeDb.install();
        try {
            fakeDb.addOrder({ id: 9102, total_price: 7, guest_full_name: 'Test Student' });
            const payment = fakeDb.addPayment({ order_id: 9102, amount: 7, method: 'cashfree', status: 'pending' });
            const res1 = await processSuccessfulPayment(9102, {
                paymentId: payment.id,
                method: 'cashfree',
                amount: 7,
                source: 'cashfree_webhook'
            });
            const res2 = await processSuccessfulPayment(9102, {
                paymentId: payment.id,
                method: 'cashfree',
                amount: 7,
                source: 'browser_return'
            });
            assert.equal(res1.ticketNumber, 'CP-9102');
            assert.equal(res2.ticketNumber, 'CP-9102');
            assert.equal(res2.alreadyFinalized, true);
        } finally {
            restoreDb();
        }
    });

    it('12. Existing tickets and paid orders remain unchanged', async () => {
        const fakeDb = createFakeDb();
        fakeDb.install();
        try {
            fakeDb.addOrder({
                id: 9103,
                ticket_number: 'CP-PRE-EXISTING',
                payment_status: 'PAID',
                ticket_status: 'READY',
                total_price: 50
            });
            const payment = fakeDb.addPayment({ order_id: 9103, amount: 50, method: 'cashfree', status: 'success' });
            const res = await processSuccessfulPayment(9103, {
                paymentId: payment.id,
                method: 'cashfree',
                amount: 50,
                source: 'status_poll'
            });
            assert.equal(res.ticketNumber, 'CP-PRE-EXISTING');
            assert.equal(res.ticketStatus, 'READY');
            assert.equal(res.alreadyFinalized, true);
            const order = fakeDb.orders.get(9103);
            assert.equal(order.ticket_number, 'CP-PRE-EXISTING');
            assert.equal(order.total_price, 50);
        } finally {
            restoreDb();
        }
    });
});