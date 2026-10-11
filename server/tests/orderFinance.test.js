// Printer vs Super Admin financial views and the canonical pricing split.
// Run: node --test server/tests/
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { PRICING, priceOrder } = require('../pricing');
const { toPrinterOrder, financialBreakdown, PRINTER_ORDER_FIELDS } = require('../services/orderFinance');

const file = (pages, copies, printingSide, colorMode) => ({ pages, copies, printingSide, colorMode });

// Fields that must never reach the Printer Admin.
const FORBIDDEN_FOR_PRINTER = [
    'total_price', 'service_charge', 'delivery_charge', 'classroom_charge', 'printing_amount',
    'ticket_access_token_hash', 'paid_at'
];

describe('canonical pricing split (unchanged customer prices)', () => {
    it('single-sided B&W: 10 pages × 2 copies = ₹40 printing + ₹3 service', () => {
        const c = priceOrder([file(10, 2, 'single', 'bw')], { collectionLocationId: 'main-gate' });
        assert.deepEqual([c.printingAmount, c.serviceCharge, c.deliveryCharge, c.classroomCharge, c.total], [40, 3, 0, 0, 43]);
    });

    it('double-sided B&W is per sheet, rounded up per copy: 5 pages × 3 copies = 3 sheets × 3 × ₹3 = ₹27', () => {
        const c = priceOrder([file(5, 3, 'double', 'bw')], { collectionLocationId: 'red-canteen' });
        assert.equal(c.printingAmount, 27);
        assert.equal(c.total, 30);
    });

    it('colour is ₹5 per page on either side', () => {
        const single = priceOrder([file(4, 1, 'single', 'color')], {});
        const double = priceOrder([file(4, 1, 'double', 'color')], {});
        assert.equal(single.printingAmount, 20);
        assert.equal(double.printingAmount, 20);
    });

    it('multiple files with different settings: per-file charges sum to the printing amount', () => {
        const c = priceOrder([file(10, 1, 'single', 'bw'), file(7, 2, 'double', 'bw'), file(3, 1, 'single', 'color')], { collectionLocationId: 'academic-block' });
        assert.deepEqual(c.fileCharges, [20, 24, 15]);
        assert.equal(c.printingAmount, 59);
        assert.equal(c.total, 62);
    });

    it('Hostel Gate adds the ₹4 delivery charge; classroom delivery adds ₹10 (never both)', () => {
        const hostel = priceOrder([file(1, 1, 'single', 'bw')], { collectionLocationId: 'hostel-gate', classroomDelivery: 'true' });
        assert.deepEqual([hostel.deliveryCharge, hostel.classroomCharge, hostel.total], [PRICING.hostelSurcharge, 0, 9]);
        const classroom = priceOrder([file(1, 1, 'single', 'bw')], { collectionLocationId: 'academic-block', classroomDelivery: 'true' });
        assert.deepEqual([classroom.deliveryCharge, classroom.classroomCharge, classroom.total], [0, PRICING.classroomDelivery, 15]);
    });

    it('the spec example: ₹30 printing + extras → printer still sees ₹30', () => {
        // 15 single-sided B&W pages = ₹30; classroom delivery + service = ₹13 extra.
        const c = priceOrder([file(15, 1, 'single', 'bw')], { collectionLocationId: 'academic-block', classroomDelivery: true });
        const order = itemisedOrder(c);
        assert.equal(toPrinterOrder(order).printer_payable, 30);
        assert.equal(financialBreakdown(order).summary.customerTotal, 43);
    });
});

function itemisedOrder(charges, extra = {}) {
    return {
        id: 101,
        ticket_number: 'CP-101',
        status: 'accepted',
        collection_location_id: 'academic-block',
        collection_location: 'Academic Block',
        guest_full_name: 'Test Student',
        payment_status: 'PAID',
        payment_method: 'CASHFREE',
        total_price: String(charges.total),
        printing_amount: String(charges.printingAmount),
        service_charge: String(charges.serviceCharge),
        delivery_charge: String(charges.deliveryCharge),
        classroom_charge: String(charges.classroomCharge),
        ticket_access_token_hash: 'a'.repeat(64),
        ...extra
    };
}

describe('Printer Admin view', () => {
    const charges = priceOrder([file(10, 1, 'single', 'bw'), file(4, 2, 'double', 'color')], { collectionLocationId: 'hostel-gate' });
    const order = itemisedOrder(charges, { collection_location_id: 'hostel-gate' });
    const files = [
        { id: 1, order_id: 101, original_name: 'a.pdf', page_count: 10, copies: 1, printing_side: 'single', color_mode: 'bw', printing_charge: '20.00', storage_path: 'secret/a.pdf' },
        { id: 2, order_id: 101, original_name: 'b.pdf', page_count: 4, copies: 2, printing_side: 'double', color_mode: 'color', printing_charge: '40.00', storage_path: 'secret/b.pdf' }
    ];
    const view = toPrinterOrder(order, files);

    it('gets only the printing amount as printer payable', () => {
        assert.equal(view.printer_payable, 60);
        assert.equal(view.itemised, true);
    });

    it('never receives the customer total, extra charges or internal fields', () => {
        const json = JSON.stringify(view);
        for (const field of FORBIDDEN_FOR_PRINTER) assert.ok(!(field in view), `${field} leaked to printer`);
        assert.ok(!json.includes(String(charges.total)) || charges.total === 60, 'customer total value leaked');
        assert.ok(!json.includes('storage_path'));
    });

    it('sees per-file print settings and printing charges', () => {
        assert.deepEqual(view.files.map(f => [f.page_count, f.copies, f.printing_side, f.color_mode, f.printing_category, f.printing_charge]), [
            [10, 1, 'single', 'bw', 'BW_SINGLE', 20],
            [4, 2, 'double', 'color', 'COLOR_DOUBLE', 40]
        ]);
    });

    it('an order placed before itemising shows no payable instead of the customer total', () => {
        const legacy = toPrinterOrder({ id: 5, total_price: '210.00', payment_status: 'PAID', printing_amount: null });
        assert.equal(legacy.itemised, false);
        assert.equal(legacy.printer_payable, null);
        assert.ok(!('total_price' in legacy));
    });

    it('the whitelist contains no money fields', () => {
        for (const field of FORBIDDEN_FOR_PRINTER) assert.ok(!PRINTER_ORDER_FIELDS.includes(field));
    });
});

describe('Super Admin breakdown', () => {
    it('itemised order: printing, extras and summary reconcile with the customer total', () => {
        const charges = priceOrder([file(15, 1, 'single', 'bw')], { collectionLocationId: 'hostel-gate' });
        const order = itemisedOrder(charges, { collection_location_id: 'hostel-gate' });
        const payments = [
            { status: 'failed', amount: '37.00' },
            { status: 'success', amount: '37.00' }
        ];
        const b = financialBreakdown(order, [{ page_count: 15, copies: 1, printing_side: 'single', color_mode: 'bw', printing_charge: '30.00' }], payments);

        assert.equal(b.basis, 'ITEMISED');
        assert.equal(b.printing.totalPrinting, 30);
        assert.equal(b.printing.printerPayable, 30);
        assert.deepEqual(b.printing.lines.map(l => [l.category, l.printedPages, l.amount]), [['BW_SINGLE', 15, 30]]);
        assert.deepEqual([b.extras.deliveryCharge, b.extras.serviceCharge, b.extras.classroomCharge, b.extras.totalExtras], [4, 3, 0, 7]);
        assert.equal(b.summary.customerTotal, 37);
        assert.equal(b.summary.amountPaid, 37);
        assert.equal(b.summary.grossExtraRevenue, 7);
        assert.equal(b.reconciliation.reconciled, true);
        assert.equal(b.reconciliation.difference, 0);
        // Not tracked by the system → explicit nulls, never guessed.
        assert.deepEqual([b.summary.taxes, b.summary.discounts, b.summary.gatewayFees], [null, null, null]);
    });

    it('flags saved charges that do not add up', () => {
        const charges = priceOrder([file(10, 1, 'single', 'bw')], {});
        const b = financialBreakdown(itemisedOrder(charges, { total_price: '99.00' }));
        assert.equal(b.reconciliation.reconciled, false);
        assert.equal(b.reconciliation.difference, 76);
        assert.ok(b.notes.some(n => n.includes('do not add up')));
    });

    it('legacy order is clearly ESTIMATED: total − service − Hostel Gate delivery', () => {
        const b = financialBreakdown({ id: 3, total_price: '210.00', printing_amount: null, collection_location_id: 'hostel-gate', payment_status: 'PAID' });
        assert.equal(b.basis, 'ESTIMATED');
        assert.equal(b.printing.printerPayable, 203);
        assert.equal(b.extras.totalExtras, 7);
        assert.equal(b.extras.classroomCharge, null);
        assert.equal(b.reconciliation.reconciled, false);
    });

    it('legacy Academic Block order warns that classroom delivery may be inside the estimate', () => {
        const b = financialBreakdown({ id: 1, total_price: '38.00', printing_amount: null, collection_location_id: 'academic-block', payment_status: 'PAID' });
        assert.equal(b.printing.printerPayable, 35);
        assert.ok(b.notes.some(n => n.includes('Classroom delivery')));
    });

    it('legacy total below the fixed charges cannot be estimated', () => {
        const b = financialBreakdown({ id: 9, total_price: '5.00', printing_amount: null, collection_location_id: 'hostel-gate', payment_status: 'PAID' });
        assert.equal(b.printing.printerPayable, null);
    });

    it('payment states: pending, failed and refunded are reported separately from the amount paid', () => {
        const charges = priceOrder([file(2, 1, 'single', 'bw')], {});
        const pending = financialBreakdown(itemisedOrder(charges, { payment_status: 'PAYMENT_PENDING' }), [], [{ status: 'pending', amount: '7.00' }]);
        assert.deepEqual([pending.summary.paymentStatus, pending.summary.amountPaid], ['PAYMENT_PENDING', 0]);
        const failed = financialBreakdown(itemisedOrder(charges, { payment_status: 'PAYMENT_FAILED' }), [], [{ status: 'failed', amount: '7.00' }]);
        assert.deepEqual([failed.summary.paymentStatus, failed.summary.amountPaid], ['PAYMENT_FAILED', 0]);
        const refunded = financialBreakdown(itemisedOrder(charges), [], [{ status: 'refunded', amount: '7.00' }]);
        assert.deepEqual([refunded.summary.paymentStatus, refunded.summary.amountPaid, refunded.summary.refundedAmount], ['REFUNDED', 0, 7]);
    });
});
