const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { priceOrder } = require('../pricing');
const cashfree = require('../cashfree');

describe('server-authoritative order pricing', () => {
    it('prices resolved files and applies only the selected delivery charge', () => {
        const result = priceOrder([{
            pages: 4,
            copies: 2,
            printingSide: 'double',
            colorMode: 'bw'
        }], { collectionLocationId: 'hostel-gate', classroomDelivery: true });

        assert.deepEqual(result, {
            printingAmount: 12,
            fileCharges: [12],
            serviceCharge: 3,
            deliveryCharge: 4,
            classroomCharge: 0,
            total: 19
        });
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
            colorMode: 'color'
        };
        const freshSettings = buildFileSettingsPayload([freshFile])[0];
        const restoredSettings = buildFileSettingsPayload([{ ...freshSettings }])[0];

        assert.deepEqual(restoredSettings, freshSettings);
        assert.equal(hasCompleteFileSettings(restoredSettings), true);

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
