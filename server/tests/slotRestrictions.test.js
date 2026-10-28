const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { pickupError, TIME_SLOTS } = require('../slots');

describe('Time Slot Availability Restrictions', () => {
    const DISABLED_SLOTS = ['11:15 AM', '1:15 PM'];
    const ENABLED_SLOTS = TIME_SLOTS.filter(t => !DISABLED_SLOTS.includes(t));

    it('permanently disables restricted slots regardless of location', () => {
        const locations = ['main-gate', 'red-canteen', 'hostel-gate', 'academic-block'];
        for (const time of DISABLED_SLOTS) {
            for (const locId of locations) {
                const error = pickupError(locId, time);
                assert.equal(error, 'This time slot is permanently unavailable.', `Slot ${time} should be disabled for ${locId}`);
            }
        }
    });

    it('keeps other slots available based on existing rules', () => {
        // We just need to verify that the disabled logic isn't accidentally blocking everything.
        // Using a slot that is known to be available in slotMatrix.json (e.g., 9:25 AM for academic-block)
        const error = pickupError('academic-block', '9:25 AM');
        // It should be null (available) or 'This time slot is no longer available' (if it's past)
        // but definitely NOT 'This time slot is permanently unavailable.'
        assert.notEqual(error, 'This time slot is permanently unavailable.', 'Enabled slot should not be marked as permanently unavailable');
    });
});
