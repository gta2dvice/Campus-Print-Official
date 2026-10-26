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
    const boundCopies = files.reduce((sum, f) => {
        const isEligible = (f.spiralBinding === true || f.spiralBinding === 'true') && (Number(f.pages) >= 5);
        return sum + (isEligible ? (Number(f.copies) || 1) : 0);
    }, 0);
    const bindingCharge = boundCopies * 26;

    const totalPages = files.reduce((sum, f) => sum + ((Number(f.pages) || 0) * (Number(f.copies) || 1)), 0);
    let serviceCharge = 0;
    files.forEach((f) => {
        const pages = Number(f.pages) || 0;
        const copies = Number(f.copies) || 1;
        if (pages > 0) {
            let perCopyService = 1;
            if (pages <= 10) perCopyService = 1;
            else if (pages <= 30) perCopyService = 2;
            else perCopyService = 3;
            serviceCharge += perCopyService * copies;
        }
    });

    const total = printingSubtotal + deliveryCharge + bindingCharge + serviceCharge;

    return {
        pages: totalPages,
        base: printingSubtotal,
        deliveryCharge,
        deliveryType,
        boundFileCount,
        boundCopies,
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

    describe('6. Copy-Based Pricing Regression Tests', () => {
        it('calculates the canonical example: 47 B&W single pages, 2 copies, binding ON -> exactly ₹246', () => {
            // Per copy: 47 * ₹2 (printing: ₹94) + ₹3 (service tier 31+) + ₹26 (binding) = ₹123
            // 2 copies: ₹123 * 2 = ₹246 (NOT 47*2*2 + 3 + 26 = ₹217)
            const files = [
                { pages: 47, copies: 2, printingSide: 'single', colorMode: 'bw', spiralBinding: true }
            ];
            const backend = priceOrder(files);
            const frontend = calcPriceFrontend(files);

            assert.equal(backend.printingAmount, 188); // 47 * 2 * 2
            assert.equal(frontend.base, 188);

            assert.equal(backend.serviceCharge, 6); // ₹3 per copy * 2 copies
            assert.equal(frontend.serviceCharge, 6);

            assert.equal(backend.bindingCharge, 52); // ₹26 per copy * 2 copies
            assert.equal(frontend.bindingCharge, 52);
            assert.equal(frontend.boundCopies, 2);

            assert.equal(backend.total, 246);
            assert.equal(frontend.total, 246);
            assert.notEqual(backend.total, 217);
        });

        it('calculates 47 B&W single pages, 1 copy, binding ON -> exactly ₹123', () => {
            const files = [
                { pages: 47, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true }
            ];
            const backend = priceOrder(files);
            const frontend = calcPriceFrontend(files);

            assert.equal(backend.printingAmount, 94);
            assert.equal(backend.serviceCharge, 3);
            assert.equal(backend.bindingCharge, 26);
            assert.equal(backend.total, 123);
            assert.equal(frontend.total, 123);
        });

        it('calculates 47 B&W single pages, 2 copies, binding OFF -> exactly ₹194', () => {
            // Per copy: 47 * ₹2 (printing: ₹94) + ₹3 (service) + ₹0 (binding) = ₹97
            // 2 copies: ₹97 * 2 = ₹194
            const files = [
                { pages: 47, copies: 2, printingSide: 'single', colorMode: 'bw', spiralBinding: false }
            ];
            const backend = priceOrder(files);
            const frontend = calcPriceFrontend(files);

            assert.equal(backend.printingAmount, 188);
            assert.equal(backend.serviceCharge, 6);
            assert.equal(backend.bindingCharge, 0);
            assert.equal(backend.total, 194);
            assert.equal(frontend.total, 194);
        });

        it('multiplies service charge tiers per copy correctly for 1-10, 11-30, and 31+ pages', () => {
            // Tier 1: 5 pages, 3 copies -> ₹1 * 3 = ₹3 service charge
            const tier1 = priceOrder([{ pages: 5, copies: 3, printingSide: 'single', colorMode: 'bw', spiralBinding: false }]);
            assert.equal(tier1.serviceCharge, 3);
            assert.equal(tier1.printingAmount, 30); // 5 * 3 * 2
            assert.equal(tier1.total, 33);

            // Tier 2: 25 pages, 2 copies -> ₹2 * 2 = ₹4 service charge
            const tier2 = priceOrder([{ pages: 25, copies: 2, printingSide: 'single', colorMode: 'bw', spiralBinding: false }]);
            assert.equal(tier2.serviceCharge, 4);
            assert.equal(tier2.printingAmount, 100); // 25 * 2 * 2
            assert.equal(tier2.total, 104);

            // Tier 3: 50 pages, 4 copies -> ₹3 * 4 = ₹12 service charge
            const tier3 = priceOrder([{ pages: 50, copies: 4, printingSide: 'single', colorMode: 'bw', spiralBinding: false }]);
            assert.equal(tier3.serviceCharge, 12);
            assert.equal(tier3.printingAmount, 400); // 50 * 4 * 2
            assert.equal(tier3.total, 412);
        });

        it('handles multiple PDFs with differing copy counts and mixed binding correctly', () => {
            // PDF 1: 8 pages B&W single (tier 1: ₹1 service), 2 copies, binding ON (eligible: 8 >= 5)
            //   per copy: 8 * 2 + 1 + 26 = 43; total = 43 * 2 = 86
            // PDF 2: 12 pages Color double (tier 2: ₹2 service), 3 copies, binding OFF
            //   per copy: 12 * 15 + 2 + 0 = 182; total = 182 * 3 = 546
            // PDF 3: 4 pages B&W double (tier 1: ₹1 service), 1 copy, spiralBinding: true (ineligible: 4 < 5)
            //   per copy: 4 * 3 + 1 + 0 = 13; total = 13 * 1 = 13
            // Delivery: Classroom Delivery (₹5) - applied once at order level
            // Expected totals:
            //   printing: 32 + 540 + 12 = 584
            //   service: (1 * 2) + (2 * 3) + (1 * 1) = 2 + 6 + 1 = 9
            //   binding: 26 * 2 + 0 + 0 = 52
            //   classroom delivery: 5
            //   order total: 584 + 9 + 52 + 5 = 650
            const files = [
                { pages: 8, copies: 2, printingSide: 'single', colorMode: 'bw', spiralBinding: true },
                { pages: 12, copies: 3, printingSide: 'double', colorMode: 'color', spiralBinding: false },
                { pages: 4, copies: 1, printingSide: 'double', colorMode: 'bw', spiralBinding: true }
            ];

            const backend = priceOrder(files, { collectionLocationId: 'academic-block', classroomDelivery: true });
            const frontend = calcPriceFrontend(files, { selectedLocationId: 'academic-block', classroomDelivery: true });

            assert.deepEqual(backend.fileCharges, [32, 540, 12]);
            assert.equal(backend.printingAmount, 584);
            assert.equal(frontend.base, 584);

            assert.equal(backend.serviceCharge, 9);
            assert.equal(frontend.serviceCharge, 9);

            assert.equal(backend.bindingCharge, 52);
            assert.equal(frontend.bindingCharge, 52);
            assert.equal(frontend.boundCopies, 2);

            assert.equal(backend.classroomCharge, 5);
            assert.equal(frontend.deliveryCharge, 5);
            assert.equal(frontend.deliveryType, 'classroom');

            assert.equal(backend.total, 650);
            assert.equal(frontend.total, 650);
        });

        it('does not multiply delivery charge when ordering multiple copies', () => {
            const files = [
                { pages: 10, copies: 5, printingSide: 'single', colorMode: 'bw', spiralBinding: false }
            ];
            // Classroom delivery: ₹5 once
            const cr = priceOrder(files, { classroomDelivery: true });
            assert.equal(cr.classroomCharge, 5);
            assert.equal(cr.printingAmount, 100); // 10 * 5 * 2
            assert.equal(cr.serviceCharge, 5);    // 1 * 5
            assert.equal(cr.total, 110);          // 100 + 5 + 5

            // Hostel delivery: ₹3 once
            const hg = priceOrder(files, { collectionLocationId: 'hostel-gate' });
            assert.equal(hg.deliveryCharge, 3);
            assert.equal(hg.total, 108);          // 100 + 5 + 3
        });
    });

    describe('7. Price Mismatch Prevention, Stale State & Idempotency Tests', () => {
        it('verifies exact agreement for 47 pages, 2 copies, binding ON with no delivery (₹246)', () => {
            const files = [
                { pages: 47, copies: 2, printingSide: 'single', colorMode: 'bw', spiralBinding: true }
            ];
            const backend = priceOrder(files, { classroomDelivery: false });
            const frontend = calcPriceFrontend(files, { classroomDelivery: false });

            assert.equal(backend.printingAmount, 188);
            assert.equal(backend.serviceCharge, 6);
            assert.equal(backend.bindingCharge, 52);
            assert.equal(backend.deliveryCharge, 0);
            assert.equal(backend.total, 246);

            assert.equal(frontend.base, 188);
            assert.equal(frontend.serviceCharge, 6);
            assert.equal(frontend.bindingCharge, 52);
            assert.equal(frontend.deliveryCharge, 0);
            assert.equal(frontend.total, 246);
        });

        it('verifies exact agreement for 47 pages, 2 copies, binding ON with Classroom Delivery (₹251)', () => {
            const files = [
                { pages: 47, copies: 2, printingSide: 'single', colorMode: 'bw', spiralBinding: true }
            ];
            const backend = priceOrder(files, { collectionLocationId: 'academic-block', classroomDelivery: true });
            const frontend = calcPriceFrontend(files, { selectedLocationId: 'academic-block', classroomDelivery: true });

            assert.equal(backend.classroomCharge, 5);
            assert.equal(backend.total, 251); // 246 + 5
            assert.equal(frontend.deliveryCharge, 5);
            assert.equal(frontend.total, 251);
        });

        it('verifies exact agreement for 47 pages, 2 copies, binding ON with Hostel Gate Delivery (₹249)', () => {
            const files = [
                { pages: 47, copies: 2, printingSide: 'single', colorMode: 'bw', spiralBinding: true }
            ];
            const backend = priceOrder(files, { collectionLocationId: 'hostel-gate', classroomDelivery: false });
            const frontend = calcPriceFrontend(files, { selectedLocationId: 'hostel-gate', classroomDelivery: false });

            assert.equal(backend.deliveryCharge, 3);
            assert.equal(backend.total, 249); // 246 + 3
            assert.equal(frontend.deliveryCharge, 3);
            assert.equal(frontend.total, 249);
        });

        it('simulates stale state rejection: submitting 2 copies with a stale 1-copy price triggers mismatch', () => {
            const files = [
                { pages: 47, copies: 2, printingSide: 'single', colorMode: 'bw', spiralBinding: true }
            ];
            const backend = priceOrder(files);
            // Stale frontend state (from before copies was changed from 1 to 2)
            const staleFrontend = calcPriceFrontend([{ pages: 47, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: true }]);

            // Authoritative server calculates ₹246; stale client total was ₹123
            assert.equal(backend.total, 246);
            assert.equal(staleFrontend.total, 123);

            // Emulate backend validation check in orders.js
            const declaredTotal = Number(staleFrontend.total);
            const isMismatch = Math.abs(declaredTotal - backend.total) > 0.01;
            assert.equal(isMismatch, true, 'Server must detect mismatch when client sends stale price');

            // Once the client state re-evaluates atomically, both agree
            const freshFrontend = calcPriceFrontend(files);
            assert.equal(Math.abs(freshFrontend.total - backend.total) <= 0.01, true, 'Atomic re-evaluated price must match server');
        });

        it('guarantees idempotency: multiple evaluations of the same state yield identical pricing', () => {
            const files = [
                { pages: 20, copies: 2, printingSide: 'double', colorMode: 'color', spiralBinding: true },
                { pages: 5, copies: 1, printingSide: 'single', colorMode: 'bw', spiralBinding: false }
            ];
            const eval1 = priceOrder(files, { collectionLocationId: 'academic-block', classroomDelivery: true });
            const eval2 = priceOrder(files, { collectionLocationId: 'academic-block', classroomDelivery: true });
            const eval3 = priceOrder(files, { collectionLocationId: 'academic-block', classroomDelivery: true });

            assert.deepEqual(eval1, eval2);
            assert.deepEqual(eval2, eval3);
        });
    });
});
