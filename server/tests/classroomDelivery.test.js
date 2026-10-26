const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { priceOrder } = require('../pricing');
const slots = require('../slots');

describe('classroom delivery order handling', () => {
    it('prices the classroom surcharge once and uses the canonical Academic Block delivery label', () => {
        const base = priceOrder([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'bw' }], {
            collectionLocationId: 'academic-block', classroomDelivery: false
        });
        const classroom = priceOrder([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'bw' }], {
            collectionLocationId: 'academic-block', classroomDelivery: true
        });
        assert.equal(classroom.classroomCharge, 5);
        assert.equal(classroom.deliveryCharge, 0);
        assert.equal(classroom.total, base.total + 5);
        assert.equal(slots.locationDisplayName('academic-block', { classroomDelivery: true }), 'Academic Block - Classroom Delivery');
    });

    it('keeps a normal Academic Block order free of classroom-delivery data and surcharge', () => {
        const normal = priceOrder([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'bw' }], {
            collectionLocationId: 'academic-block', classroomDelivery: false
        });
        assert.equal(slots.locationDisplayName('academic-block', { classroomDelivery: false }), 'Academic Block');
        assert.equal(normal.classroomCharge, 0);
        assert.equal(normal.deliveryCharge, 0);
        assert.equal(slots.isClassroomDeliveryOrder({
            classroomCharge: normal.classroomCharge,
            collectionLocation: 'Academic Block'
        }), false);
    });

    it('does not identify a normal order as a classroom-delivery ticket', () => {
        assert.equal(slots.isClassroomDeliveryOrder({ classroomCharge: 0, collectionLocation: 'Academic Block' }), false);
        assert.equal(slots.isClassroomDeliveryOrder({ classroomCharge: 5, collectionLocation: 'Academic Block - Classroom Delivery' }), true);
    });
});

describe('current pricing rules', () => {
    it('charges each print mode per billable page and applies the service charge once', () => {
        const priced = priceOrder([
            { pages: 2, copies: 1, printingSide: 'single', colorMode: 'bw' },
            { pages: 2, copies: 1, printingSide: 'double', colorMode: 'bw' },
            { pages: 2, copies: 1, printingSide: 'single', colorMode: 'color' },
            { pages: 2, copies: 1, printingSide: 'double', colorMode: 'color' }
        ]);
        assert.deepEqual(priced.fileCharges, [4, 6, 24, 30]);
        assert.equal(priced.printedPages, 8);
        assert.equal(priced.serviceCharge, 1);
        assert.equal(priced.total, 65);
    });

    it('applies the 31+ service charge once above 100 billable pages', () => {
        const priced = priceOrder([{ pages: 101, copies: 1, printingSide: 'single', colorMode: 'bw' }]);
        assert.equal(priced.serviceCharge, 3);
        assert.equal(priced.total, 205);
    });

    it('adds the binding price and its one-rupee service fee once per selected file', () => {
        const priced = priceOrder([
            { pages: 5, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true },
            { pages: 5, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: false }
        ]);
        assert.equal(priced.bindingCharge, 26);
        assert.equal(priced.total, 47);
    });
});
