const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { PRICING, priceOrder, filePrintingCost } = require('../pricing');

// Frontend calculation replica matching NewOrder.jsx calcPrice() logic
function calcPriceFrontend(files, { selectedLocationId, classroomDelivery } = {}) {
    const printingSubtotal = files.reduce((sum, f) => {
        const pages = Number(f.pages) || 0;
        const copies = Number(f.copies) || 1;
        if (f.colorMode === 'color') return sum + pages * copies * (f.printingSide === 'double' ? 15 : 12);
        if (f.printingSide === 'double') return sum + pages * copies * 3;
        return sum + pages * copies * 2;
    }, 0);

    let deliveryCharge = 0;
    let deliveryType = 'none';
    if (classroomDelivery) {
        deliveryCharge = 5;
        deliveryType = 'classroom';
    } else if (selectedLocationId === 'hostel-gate') {
        deliveryCharge = 3;
        deliveryType = 'hostel';
    }

    const boundFileCount = files.filter(f => (f.spiralBinding === true || f.spiralBinding === 'true') && (Number(f.pages) >= 5)).length;
    const bindingCharge = boundFileCount * 26;

    const totalPages = files.reduce((sum, f) => sum + ((Number(f.pages) || 0) * (Number(f.copies) || 1)), 0);
    let serviceCharge = 0;
    if (totalPages > 0) {
        if (totalPages <= 10) serviceCharge = 1;
        else if (totalPages <= 30) serviceCharge = 2;
        else serviceCharge = 3;
    }

    const total = printingSubtotal + deliveryCharge + bindingCharge + serviceCharge;

    return {
        pages: totalPages,
        base: printingSubtotal,
        deliveryCharge,
        deliveryType,
        boundFileCount,
        bindingCharge,
        serviceCharge,
        total
    };
}

describe('Order Summary & Review Charges Verification', () => {
    describe('1. Printing Charges Rates', () => {
        it('calculates B&W single-sided at ₹2/page', () => {
            const result = priceOrder([{ pages: 5, copies: 1, printingSide: 'single', colorMode: 'bw' }], { includeServiceCharge: false });
            assert.equal(result.printingAmount, 10);
        });

        it('calculates B&W double-sided at ₹3/page', () => {
            const result = priceOrder([{ pages: 5, copies: 1, printingSide: 'double', colorMode: 'bw' }], { includeServiceCharge: false });
            assert.equal(result.printingAmount, 15);
        });

        it('calculates Color single-sided at ₹12/page', () => {
            const result = priceOrder([{ pages: 5, copies: 1, printingSide: 'single', colorMode: 'color' }], { includeServiceCharge: false });
            assert.equal(result.printingAmount, 60);
        });

        it('calculates Color double-sided at ₹15/page', () => {
            const result = priceOrder([{ pages: 5, copies: 1, printingSide: 'double', colorMode: 'color' }], { includeServiceCharge: false });
            assert.equal(result.printingAmount, 75);
        });
    });

    describe('2. Service Charge Tiers', () => {
        it('charges ₹1 for 1 to 10 billable pages', () => {
            assert.equal(priceOrder([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 1);
            assert.equal(priceOrder([{ pages: 10, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 1);
        });

        it('charges ₹2 for 11 to 30 billable pages', () => {
            assert.equal(priceOrder([{ pages: 11, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 2);
            assert.equal(priceOrder([{ pages: 30, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 2);
        });

        it('charges ₹3 for 31+ billable pages', () => {
            assert.equal(priceOrder([{ pages: 31, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 3);
            assert.equal(priceOrder([{ pages: 100, copies: 1, printingSide: 'single', colorMode: 'bw' }]).serviceCharge, 3);
        });
    });

    describe('3. Binding Charges & Eligibility', () => {
        it('charges ₹26 total when binding is selected for an eligible PDF (>= 5 pages)', () => {
            const result = priceOrder([{ pages: 5, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true }], { includeServiceCharge: false });
            assert.equal(result.bindingCharge, 26);
            const fe = calcPriceFrontend([{ pages: 5, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true }]);
            assert.equal(fe.boundFileCount, 1);
            assert.equal(fe.bindingCharge, 26);
        });

        it('charges ₹0 when binding is not selected', () => {
            const result = priceOrder([{ pages: 5, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: false }], { includeServiceCharge: false });
            assert.equal(result.bindingCharge, 0);
            const fe = calcPriceFrontend([{ pages: 5, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: false }]);
            assert.equal(fe.boundFileCount, 0);
            assert.equal(fe.bindingCharge, 0);
        });

        it('charges ₹0 when file has < 5 pages even if spiralBinding is requested (ineligible)', () => {
            const result = priceOrder([{ pages: 4, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true }], { includeServiceCharge: false });
            assert.equal(result.bindingCharge, 0);
            const fe = calcPriceFrontend([{ pages: 4, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true }]);
            assert.equal(fe.boundFileCount, 0);
            assert.equal(fe.bindingCharge, 0);
        });

        it('charges ₹26 per eligible bound document across multiple files without extra fees', () => {
            const files = [
                { pages: 6, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true },
                { pages: 10, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true },
                { pages: 8, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: false },
                { pages: 2, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true } // ineligible (<5)
            ];
            const result = priceOrder(files, { includeServiceCharge: false });
            assert.equal(result.bindingCharge, 52); // 2 * 26
            const fe = calcPriceFrontend(files);
            assert.equal(fe.boundFileCount, 2);
            assert.equal(fe.bindingCharge, 52);
        });
    });

    describe('4. Delivery Charges & Mutual Exclusivity', () => {
        it('charges ₹5 for classroom delivery at Academic Block', () => {
            const result = priceOrder([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'bw' }], {
                collectionLocationId: 'academic-block',
                classroomDelivery: true,
                includeServiceCharge: false
            });
            assert.equal(result.classroomCharge, 5);
            assert.equal(result.deliveryCharge, 0);
            const fe = calcPriceFrontend([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'bw' }], {
                selectedLocationId: 'academic-block',
                classroomDelivery: true
            });
            assert.equal(fe.deliveryCharge, 5);
            assert.equal(fe.deliveryType, 'classroom');
        });

        it('charges ₹3 for hostel gate delivery', () => {
            const result = priceOrder([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'bw' }], {
                collectionLocationId: 'hostel-gate',
                classroomDelivery: false,
                includeServiceCharge: false
            });
            assert.equal(result.deliveryCharge, 3);
            assert.equal(result.classroomCharge, 0);
            const fe = calcPriceFrontend([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'bw' }], {
                selectedLocationId: 'hostel-gate',
                classroomDelivery: false
            });
            assert.equal(fe.deliveryCharge, 3);
            assert.equal(fe.deliveryType, 'hostel');
        });

        it('charges ₹0 when no delivery option is selected (standard pickup)', () => {
            const result = priceOrder([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'bw' }], {
                collectionLocationId: 'main-gate',
                classroomDelivery: false,
                includeServiceCharge: false
            });
            assert.equal(result.deliveryCharge, 0);
            assert.equal(result.classroomCharge, 0);
            const fe = calcPriceFrontend([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'bw' }], {
                selectedLocationId: 'main-gate',
                classroomDelivery: false
            });
            assert.equal(fe.deliveryCharge, 0);
            assert.equal(fe.deliveryType, 'none');
        });

        it('never charges both hostel and classroom delivery together in frontend calculations', () => {
            // Even if state has both classroomDelivery: true and selectedLocationId: 'hostel-gate'
            const fe = calcPriceFrontend([{ pages: 1, copies: 1, printingSide: 'single', colorMode: 'bw' }], {
                selectedLocationId: 'hostel-gate',
                classroomDelivery: true
            });
            assert.equal(fe.deliveryCharge, 5); // classroom delivery takes precedence, never 5 + 3 = 8
            assert.equal(fe.deliveryType, 'classroom');
        });
    });

    describe('5. Combined Charges & Total Consistency', () => {
        it('computes consistent order totals across frontend and backend for complex order', () => {
            // 2 files:
            // File 1: 10 pages B&W single (10 * 2 = ₹20), bound (₹26)
            // File 2: 4 pages Color double (4 * 15 = ₹60), not bound
            // Total pages = 14 -> Service charge = ₹2 (11-30 tier)
            // Delivery: Classroom delivery -> ₹5
            // Expected Total: 20 + 60 + 26 + 2 + 5 = ₹113
            const files = [
                { pages: 10, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true },
                { pages: 4, copies: 1, printingSide: 'double', colorMode: 'color', spiralBinding: false }
            ];
            const backend = priceOrder(files, { collectionLocationId: 'academic-block', classroomDelivery: true });
            const frontend = calcPriceFrontend(files, { selectedLocationId: 'academic-block', classroomDelivery: true });

            assert.equal(backend.printingAmount, 80);
            assert.equal(frontend.base, 80);

            assert.equal(backend.serviceCharge, 2);
            assert.equal(frontend.serviceCharge, 2);

            assert.equal(backend.bindingCharge, 26);
            assert.equal(frontend.bindingCharge, 26);

            assert.equal(backend.classroomCharge, 5);
            assert.equal(frontend.deliveryCharge, 5);

            assert.equal(backend.total, 113);
            assert.equal(frontend.total, 113);
        });

        it('computes consistent order totals for hostel delivery without binding', () => {
            // 1 file: 5 pages B&W double (5 * 3 = ₹15)
            // Total pages = 5 -> Service charge = ₹1
            // Delivery: Hostel Gate -> ₹3
            // Expected Total: 15 + 1 + 3 = ₹19
            const files = [
                { pages: 5, copies: 1, printingSide: 'double', colorMode: 'bw', spiralBinding: false }
            ];
            const backend = priceOrder(files, { collectionLocationId: 'hostel-gate', classroomDelivery: false });
            const frontend = calcPriceFrontend(files, { selectedLocationId: 'hostel-gate', classroomDelivery: false });

            assert.equal(backend.total, 19);
            assert.equal(frontend.total, 19);
        });
    });
});
