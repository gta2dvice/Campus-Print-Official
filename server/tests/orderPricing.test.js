const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { priceOrder } = require('../pricing');
const cashfree = require('../cashfree');

describe('server-authoritative order pricing', () => {
    it('prices files using the established B&W per-sheet rule without hidden order fees', () => {
        const result = priceOrder([{
            pages: 4,
            copies: 2,
            printingSide: 'double',
            colorMode: 'bw'
        }], { collectionLocationId: 'hostel-gate' });

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
            { pages: 2, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true },
            { pages: 3, copies: 1, printingSide: 'double', colorMode: 'bw', spiralBinding: false },
            { pages: 4, copies: 1, printingSide: 'double', colorMode: 'color', spiralBinding: true }
        ];
        const result = priceOrder(files, { classroomDelivery: true });

        assert.deepEqual(result.fileCharges, [4, 6, 20]);
        assert.equal(result.printingAmount, 30);
        assert.equal(result.serviceCharge, 0);
        assert.equal(result.classroomCharge, 5);
        assert.equal(result.bindingCharge, 52);
        assert.equal(result.total, 87);
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
