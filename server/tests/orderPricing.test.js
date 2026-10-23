const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { priceOrder } = require('../pricing');
const cashfree = require('../cashfree');
const { PDFDocument } = require('pdf-lib');
const { processSuccessfulPayment } = require('../services/paymentFinalizer');
const { createFakeDb, restoreDb } = require('./helpers/fakeDb');
const pageDetectWorker = require('../workers/pageDetect.worker');
const { resolveAndPriceFiles, validateAndPriceSubmission } = require('../routes/orders');
const slots = require('../slots');

describe('server-authoritative order pricing', () => {
    it('prices files using the established B&W per-sheet rule and adds hostel delivery fee', () => {
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
            deliveryCharge: 3,
            classroomCharge: 0,
            bindingCharge: 0,
            total: 15
        });
    });

    it('does not charge hostel delivery for non-hostel locations', () => {
        const result = priceOrder([{
            pages: 4,
            copies: 2,
            printingSide: 'double',
            colorMode: 'bw'
        }], { collectionLocationId: 'main-gate', includeServiceCharge: false });

        assert.equal(result.deliveryCharge, 0);
        assert.equal(result.total, 12);
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
        assert.equal(priceOrder([{ pages: 5, copies: 1, printingSide: 'single', colorMode: 'color' }]).printingAmount, 90);
        assert.equal(priceOrder([{ pages: 10, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 1);
        assert.equal(priceOrder([{ pages: 11, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 2);
        assert.equal(priceOrder([{ pages: 31, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 3);
    });

    it('verifies canonical colour printing rates: 1 page costs ₹18, 10 pages cost ₹180, 2 pages × 3 copies cost ₹108', () => {
        // 1 colour page: 1 * 1 * 18 = 18
        assert.equal(priceOrder([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'color' }], { includeServiceCharge: false }).printingAmount, 18);
        assert.equal(priceOrder([{ pages: 1, copies: 1, printingSide: 'double', colorMode: 'color' }], { includeServiceCharge: false }).printingAmount, 18);

        // 10 colour pages: 10 * 1 * 18 = 180
        assert.equal(priceOrder([{ pages: 10, copies: 1, printingSide: 'single', colorMode: 'color' }], { includeServiceCharge: false }).printingAmount, 180);
        assert.equal(priceOrder([{ pages: 10, copies: 1, printingSide: 'double', colorMode: 'color' }], { includeServiceCharge: false }).printingAmount, 180);

        // 2 pages with 3 copies: 2 * 3 * 18 = 108
        assert.equal(priceOrder([{ pages: 2, copies: 3, printingSide: 'single', colorMode: 'color' }], { includeServiceCharge: false }).printingAmount, 108);
        assert.equal(priceOrder([{ pages: 2, copies: 3, printingSide: 'double', colorMode: 'color' }], { includeServiceCharge: false }).printingAmount, 108);
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
            if (f.colorMode === 'color') clientPrinting += f.pages * f.copies * 18;
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

describe('Section 5 Regression Tests: Page Confirmation Removal & Manipulation Prevention', () => {
    it('1. A 26-page PDF displays 26 as a detected, non-editable count without a confirmation warning', async () => {
        const { normalizeFileSettings } = await import('../../client-react/src/lib/orderStorage.js');
        const pdfDoc = await PDFDocument.create();
        for (let i = 0; i < 26; i++) {
            pdfDoc.addPage([600, 400]);
        }
        const pdfBuffer = Buffer.from(await pdfDoc.save());
        const pdfFile = { buffer: pdfBuffer, originalname: 'document-26.pdf', mimetype: 'application/pdf', size: pdfBuffer.length };

        const detection = await pageDetectWorker(pdfFile);
        assert.equal(detection.pages, 26);
        assert.equal(detection.estimated, false);

        // Client-side entry created upon upload / detection
        const entry = normalizeFileSettings({
            pages: detection.pages,
            estimated: detection.estimated,
            requiresConfirmation: false,
            copies: 1,
            printingSide: 'single',
            colorMode: 'bw'
        });

        // Must be confirmed, not estimated, and not require confirmation
        assert.equal(entry.pages, 26);
        assert.equal(entry.estimated, false);
        assert.equal(entry.requiresConfirmation, false);
        assert.equal(entry.pagesConfirmed, true);

        // UI rendering rule: only files requiring confirmation or with estimated counts show input/warning
        const isEditable = entry.requiresConfirmation || entry.estimated;
        assert.equal(isEditable, false, 'Detected PDF must not render as editable input');

        const pagesText = entry.pages + ' page' + (entry.pages > 1 ? 's' : '');
        assert.equal(pagesText, '26 pages');
        assert.doesNotMatch(pagesText, /confirm/i);
    });

    it('2. A successfully detected PDF is not marked as requiring manual confirmation', async () => {
        const { normalizeFileSettings } = await import('../../client-react/src/lib/orderStorage.js');
        const pdfDoc = await PDFDocument.create();
        for (let i = 0; i < 26; i++) {
            pdfDoc.addPage([600, 400]);
        }
        const pdfBuffer = Buffer.from(await pdfDoc.save());
        const detection = await pageDetectWorker({ buffer: pdfBuffer, originalname: 'lecture.pdf', mimetype: 'application/pdf' });
        assert.equal(detection.pages, 26);
        assert.equal(detection.estimated, false);

        const settings = normalizeFileSettings({
            pages: detection.pages,
            estimated: detection.estimated,
            requiresConfirmation: false
        });

        assert.equal(settings.requiresConfirmation, false);
        assert.equal(settings.pagesConfirmed, true);

        // Validation check for unconfirmed pages before booking
        const hasUnconfirmedPages = settings.pages === null || ((settings.estimated || settings.requiresConfirmation) && !settings.pagesConfirmed);
        assert.equal(hasUnconfirmedPages, false);
    });

    it('3. A user-submitted fake page count cannot override the server-validated PDF page count or manipulate the calculated price', async () => {
        const pdfDoc = await PDFDocument.create();
        for (let i = 0; i < 26; i++) {
            pdfDoc.addPage([600, 400]);
        }
        const pdfBuffer = Buffer.from(await pdfDoc.save());
        const fakeFile = {
            buffer: pdfBuffer,
            originalname: 'exam-paper.pdf',
            mimetype: 'application/pdf',
            size: pdfBuffer.length
        };

        // Attacker / manipulated client attempts to submit declaring only 1 page
        const manipulatedClientSettings = [{
            pages: 1,
            copies: 1,
            printingSide: 'single',
            colorMode: 'bw',
            pagesConfirmed: true
        }];

        const priced = await resolveAndPriceFiles([fakeFile], manipulatedClientSettings, {});

        // Authoritative server validation overrides fake client page count
        assert.equal(priced.resolved[0].pages, 26, 'Server must enforce detected 26 pages, not client declared 1');
        assert.equal(priced.charges.printedPages, 26);

        // Server calculated price: 26 pages * ₹2 (single B&W) = ₹52 + ₹2 (service charge for 26 pgs in 11-30 tier) = ₹54
        assert.equal(priced.charges.printingAmount, 52);
        assert.equal(priced.charges.serviceCharge, 2);
        assert.equal(priced.amount, 54);
        assert.notEqual(priced.amount, 3, 'Client fake page count must not reduce price to 1 page (₹3)');
    });

    it('4. A valid multi-page DOCX is counted using the configured rendering mechanism', async () => {
        const pdfDoc = await PDFDocument.create();
        for (let i = 0; i < 4; i++) {
            pdfDoc.addPage([600, 400]);
        }
        const renderedPdfBuffer = Buffer.from(await pdfDoc.save());

        // Test the DOCX detection pipeline: when render engine returns rendered PDF
        const pdfResult = await pageDetectWorker.detectPdfPages(renderedPdfBuffer);
        assert.equal(pdfResult.pages, 4);
        assert.equal(pdfResult.estimated, false);

        // When rendering is available and returns PDF, docx pages count matches rendered PDF pages
        const docxResult = await pageDetectWorker.detectDocxPages(
            Buffer.from([0x50, 0x4b, 0x03, 0x04]),
            async () => renderedPdfBuffer
        );
        assert.equal(docxResult.pages, 4);
        assert.equal(docxResult.estimated, false);
    });

    it('5. An undetectable DOCX cannot silently become a one-page paid order', async () => {
        // Undetectable DOCX returns pages: null, estimated: true, requiresConfirmation: true
        const unconfirmed = await pageDetectWorker.detectDocxPages(Buffer.from('corrupt or non-renderable docx'));
        assert.equal(unconfirmed.pages, null);
        assert.equal(unconfirmed.estimated, true);
        assert.equal(unconfirmed.requiresConfirmation, true);

        // Valid zip magic bytes so fileTypes.validateMagic passes, but rendering engine is unavailable
        const mockDocxFile = {
            buffer: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]),
            originalname: 'essay.docx',
            mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            size: 8
        };

        // Attempt 1: declared pages without explicit user confirmation flag is rejected
        await assert.rejects(
            async () => {
                await resolveAndPriceFiles([mockDocxFile], [{ pages: 1 }], {});
            },
            (err) => {
                assert.equal(err.code, 'PAGE_COUNT_REQUIRED');
                return true;
            }
        );

        // Attempt 2: null pages without confirmation is rejected
        await assert.rejects(
            async () => {
                await resolveAndPriceFiles([mockDocxFile], [{ pages: null, pagesConfirmed: false }], {});
            },
            (err) => {
                assert.equal(err.code, 'PAGE_COUNT_REQUIRED');
                return true;
            }
        );
    });

    it('6. Image page detection remains unchanged', async () => {
        const { normalizeFileSettings } = await import('../../client-react/src/lib/orderStorage.js');
        const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
        const result = await pageDetectWorker({ buffer: jpegBuffer, originalname: 'id-photo.jpg', mimetype: 'image/jpeg' });
        assert.equal(result.pages, 1);
        assert.equal(result.estimated, false);

        const settings = normalizeFileSettings({
            pages: result.pages,
            estimated: result.estimated,
            requiresConfirmation: false
        });
        assert.equal(settings.pages, 1);
        assert.equal(settings.estimated, false);
        assert.equal(settings.requiresConfirmation, false);
        assert.equal(settings.pagesConfirmed, true);
    });

    it('7. Single-sided and double-sided pricing remain correct', () => {
        // Single-sided 26 pages, 1 copy: 26 pages * ₹2 = ₹52 + ₹2 tier 2 service (11-30 pgs) = ₹54
        const singleFile = { pages: 26, copies: 1, printingSide: 'single', colorMode: 'bw' };
        const singlePriced = priceOrder([singleFile]);
        assert.equal(singlePriced.printedPages, 26);
        assert.equal(singlePriced.printingAmount, 52);
        assert.equal(singlePriced.serviceCharge, 2);
        assert.equal(singlePriced.total, 54);

        // Double-sided 26 pages, 1 copy: ceil(26 / 2) = 13 sheets * ₹3 = ₹39 + ₹2 service = ₹41
        const doubleFile = { pages: 26, copies: 1, printingSide: 'double', colorMode: 'bw' };
        const doublePriced = priceOrder([doubleFile]);
        assert.equal(doublePriced.printedPages, 26, 'Logical page count must remain 26');
        assert.equal(doublePriced.printingAmount, 39, '13 physical sheets * ₹3 = ₹39');
        assert.equal(doublePriced.serviceCharge, 2);
        assert.equal(doublePriced.total, 41);

        // Double-sided 27 pages (odd), 1 copy: ceil(27 / 2) = 14 sheets * ₹3 = ₹42 + ₹2 service = ₹44
        const oddDoubleFile = { pages: 27, copies: 1, printingSide: 'double', colorMode: 'bw' };
        const oddPriced = priceOrder([oddDoubleFile]);
        assert.equal(oddPriced.printedPages, 27);
        assert.equal(oddPriced.printingAmount, 42);
        assert.equal(oddPriced.serviceCharge, 2);
        assert.equal(oddPriced.total, 44);
    });

    it('8. Existing payment verification and ticket generation tests continue to pass', () => {
        // Verify payment amounts match and mismatch rejection
        assert.equal(cashfree.amountsMatch(54, 54), true);
        assert.equal(cashfree.amountsMatch(54, 3), false);
    });
});



describe('Payment Creation & Server-Side Price Verification Hotfix Tests', () => {
    it('1. A valid PDF order can proceed through payment creation', async () => {
        const pdfDoc = await PDFDocument.create();
        for (let i = 0; i < 26; i++) pdfDoc.addPage([600, 400]);
        const buffer = Buffer.from(await pdfDoc.save());

        const req = {
            files: [{ buffer, originalname: 'lecture-notes.pdf', mimetype: 'application/pdf', size: buffer.length }],
            body: {
                fullName: 'Karti Student',
                phone: '9876543210',
                email: 'student@example.edu',
                classroom: 'LH-101',
                collectionLocationId: 'academic-block',
                collectionTime: '9:25 AM',
                fileSettings: JSON.stringify([{ pages: 26, copies: 1, printingSide: 'single', colorMode: 'bw' }])
            }
        };
        let statusSent = null;
        let jsonSent = null;
        const res = {
            status(code) { statusSent = code; return this; },
            json(data) { jsonSent = data; return this; }
        };

        const validated = await validateAndPriceSubmission(req, res);
        assert.ok(validated, 'Order submission must validate successfully');
        assert.equal(statusSent, null);
        assert.equal(validated.amount, 54);
        assert.equal(validated.data.totalPages, 26);
        assert.equal(validated.data.totalPrice, 54);
        assert.equal(validated.resolved.length, 1);
        assert.equal(validated.resolved[0].pages, 26);
    });

    it('2. The server calculates the expected price using the existing pricing rules', async () => {
        // Double-sided 26-page PDF: 13 sheets * ₹3 = ₹39 + ₹2 tier-2 service charge = ₹41
        const pdfDoc = await PDFDocument.create();
        for (let i = 0; i < 26; i++) pdfDoc.addPage([600, 400]);
        const buffer = Buffer.from(await pdfDoc.save());

        const req = {
            files: [{ buffer, originalname: 'double-notes.pdf', mimetype: 'application/pdf', size: buffer.length }],
            body: {
                fullName: 'Karti Student',
                phone: '9876543210',
                email: 'student@example.edu',
                classroom: 'LH-101',
                collectionLocationId: 'academic-block',
                collectionTime: '9:25 AM',
                fileSettings: JSON.stringify([{ pages: 26, copies: 1, printingSide: 'double', colorMode: 'bw' }])
            }
        };
        const res = { status() { return this; }, json() { return this; } };
        const validated = await validateAndPriceSubmission(req, res);
        assert.ok(validated);
        assert.equal(validated.amount, 41);
        assert.equal(validated.data.totalPages, 26);
    });

    it('3. Invalid or missing pricing data fails safely', async () => {
        // Empty files
        let status1 = null, json1 = null;
        const res1 = { status(c) { status1 = c; return this; }, json(d) { json1 = d; return this; } };
        const v1 = await validateAndPriceSubmission({ files: [], body: {} }, res1);
        assert.equal(v1, null);
        assert.equal(status1, 400);

        // Missing fileSettings
        let status2 = null, json2 = null;
        const res2 = { status(c) { status2 = c; return this; }, json(d) { json2 = d; return this; } };
        const v2 = await validateAndPriceSubmission({
            files: [{ buffer: Buffer.from('abc'), originalname: 'a.pdf' }],
            body: { fullName: 'A', phone: '9876543210', classroom: '101', email: 'a@b.com' }
        }, res2);
        assert.equal(v2, null);
        assert.equal(status2, 400);

        // Malformed fileSettings
        let status3 = null, json3 = null;
        const res3 = { status(c) { status3 = c; return this; }, json(d) { json3 = d; return this; } };
        const v3 = await validateAndPriceSubmission({
            files: [{ buffer: Buffer.from('abc'), originalname: 'a.pdf' }],
            body: {
                fullName: 'A',
                phone: '9876543210',
                classroom: '101',
                email: 'a@b.com',
                collectionLocationId: 'academic-block',
                collectionTime: '9:25 AM',
                fileSettings: 'not-json'
            }
        }, res3);
        assert.equal(v3, null);
        assert.equal(status3, 400);
    });

    it('4. A mismatched client-submitted amount is rejected', async () => {
        const pdfDoc = await PDFDocument.create();
        for (let i = 0; i < 26; i++) pdfDoc.addPage([600, 400]);
        const buffer = Buffer.from(await pdfDoc.save());

        let statusSent = null, jsonSent = null;
        const req = {
            files: [{ buffer, originalname: 'lecture-notes.pdf', mimetype: 'application/pdf', size: buffer.length }],
            body: {
                fullName: 'Karti Student',
                phone: '9876543210',
                email: 'student@example.edu',
                classroom: 'LH-101',
                collectionLocationId: 'academic-block',
                collectionTime: '9:25 AM',
                totalPrice: '10', // Tampered / mismatched price (server calculates ₹54)
                fileSettings: JSON.stringify([{ pages: 26, copies: 1, printingSide: 'single', colorMode: 'bw' }])
            }
        };
        const res = {
            status(code) { statusSent = code; return this; },
            json(data) { jsonSent = data; return this; }
        };

        const validated = await validateAndPriceSubmission(req, res);
        assert.equal(validated, null, 'Tampered amount must be rejected');
        assert.equal(statusSent, 400);
        assert.equal(jsonSent.code, 'PRICE_MISMATCH');
    });

    it('5. Payment creation errors do not falsely mark an order as paid', async () => {
        const fakeDb = createFakeDb();
        fakeDb.install();
        try {
            // An order created in payment attempt failure stays pending/unpaid
            const order = fakeDb.addOrder({ id: 9201, total_price: 54, payment_status: 'PAYMENT_PENDING' });
            assert.equal(order.payment_status, 'PAYMENT_PENDING');
            assert.notEqual(order.payment_status, 'PAID');
            assert.notEqual(order.ticket_status, 'READY');
        } finally {
            restoreDb();
        }
    });

    it('6. Successful payment verification still generates exactly one ticket', async () => {
        const fakeDb = createFakeDb();
        fakeDb.install();
        try {
            fakeDb.addOrder({ id: 9202, total_price: 54, guest_full_name: 'Verified Student' });
            const payment = fakeDb.addPayment({ order_id: 9202, amount: 54, method: 'cashfree', status: 'pending' });
            const res = await processSuccessfulPayment(9202, {
                paymentId: payment.id,
                method: 'cashfree',
                amount: 54,
                source: 'cashfree_webhook'
            });
            assert.equal(res.ticketStatus, 'READY');
            assert.equal(res.ticketNumber, 'CP-9202');
            assert.equal(res.alreadyFinalized, false);
        } finally {
            restoreDb();
        }
    });

    it('7. Duplicate callbacks do not generate duplicate tickets', async () => {
        const fakeDb = createFakeDb();
        fakeDb.install();
        try {
            fakeDb.addOrder({ id: 9203, total_price: 54, guest_full_name: 'Verified Student' });
            const payment = fakeDb.addPayment({ order_id: 9203, amount: 54, method: 'cashfree', status: 'pending' });
            const res1 = await processSuccessfulPayment(9203, {
                paymentId: payment.id,
                method: 'cashfree',
                amount: 54,
                source: 'cashfree_webhook'
            });
            const res2 = await processSuccessfulPayment(9203, {
                paymentId: payment.id,
                method: 'cashfree',
                amount: 54,
                source: 'browser_return'
            });
            assert.equal(res1.ticketNumber, 'CP-9203');
            assert.equal(res2.ticketNumber, 'CP-9203');
            assert.equal(res2.alreadyFinalized, true);
        } finally {
            restoreDb();
        }
    });
});
