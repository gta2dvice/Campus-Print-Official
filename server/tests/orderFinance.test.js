// Printer vs Super Admin financial views and the canonical pricing split.
// Run: node --test server/tests/
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { priceOrder: basePriceOrder } = require('../pricing');
const priceOrder = (files, opts) => basePriceOrder(files, { includeServiceCharge: false, ...opts });
const { toPrinterOrder, financialBreakdown, PRINTER_ORDER_FIELDS } = require('../services/orderFinance');

const file = (pages, copies, printingSide, colorMode) => ({ pages, copies, printingSide, colorMode });

// Fields that must never reach the Printer Admin.
const FORBIDDEN_FOR_PRINTER = [
    'total_price', 'service_charge', 'delivery_charge', 'classroom_charge', 'binding_charge', 'printing_amount',
    'ticket_access_token_hash', 'paid_at'
];

describe('canonical pricing split (customer prices)', () => {
    it('does not add page-based service fees to printing totals', () => {
        const nine = priceOrder([file(9, 1, 'single', 'bw')], {});
        assert.deepEqual([nine.printingAmount, nine.serviceCharge, nine.total], [18, 0, 18]);
        const twentyTwo = priceOrder([file(22, 1, 'single', 'bw')], {});
        assert.deepEqual([twentyTwo.printingAmount, twentyTwo.serviceCharge, twentyTwo.total], [44, 0, 44]);
        const fifty = priceOrder([file(50, 1, 'single', 'bw')], {});
        assert.deepEqual([fifty.printingAmount, fifty.serviceCharge, fifty.total], [100, 0, 100]);
    });

    it('charges pickup points free of delivery fees', () => {
        const c = priceOrder([file(10, 2, 'single', 'bw')], { collectionLocationId: 'main-gate' });
        assert.deepEqual([c.printingAmount, c.serviceCharge, c.deliveryCharge, c.classroomCharge, c.bindingCharge, c.total], [40, 0, 0, 0, 0, 40]);
    });

    it('double-sided B&W is ₹3 per page: 5 pages × 3 copies × ₹3 = ₹45', () => {
        const c = priceOrder([file(5, 3, 'double', 'bw')], { collectionLocationId: 'red-canteen' });
        assert.equal(c.printingAmount, 45);
        assert.equal(c.total, 45);
    });

    it('colour is ₹12 per page single-sided and ₹15 per page double-sided', () => {
        const single = priceOrder([file(4, 1, 'single', 'color')], {});
        const double = priceOrder([file(4, 1, 'double', 'color')], {});
        assert.equal(single.printingAmount, 48);
        assert.equal(double.printingAmount, 60);
    });

    it('multiple files with different settings: per-file charges sum to the printing amount', () => {
        const c = priceOrder([file(10, 1, 'single', 'bw'), file(7, 2, 'double', 'bw'), file(3, 1, 'single', 'color')], { collectionLocationId: 'academic-block' });
        assert.deepEqual(c.fileCharges, [20, 42, 36]);
        assert.equal(c.printingAmount, 98);
        assert.equal(c.total, 98);
    });

    it('classroom delivery adds ₹5 once; Hostel Gate adds ₹3 delivery (never both)', () => {
        const classroom = priceOrder([file(1, 1, 'single', 'bw')], { collectionLocationId: 'hostel-gate', classroomDelivery: 'true' });
        assert.deepEqual([classroom.deliveryCharge, classroom.classroomCharge, classroom.total], [0, 5, 7]);
        const hostel = priceOrder([file(1, 1, 'single', 'bw')], { collectionLocationId: 'hostel-gate' });
        assert.deepEqual([hostel.deliveryCharge, hostel.classroomCharge, hostel.total], [3, 0, 5]);
    });

    it('legacy order-wide binding remains supported when per-file settings are absent', () => {
        const without = priceOrder([file(9, 1, 'single', 'bw')], {});
        const withBinding = priceOrder([file(9, 1, 'single', 'bw')], { binding: true });
        assert.equal(withBinding.bindingCharge, 26);
        assert.equal(withBinding.serviceCharge, 0);
        assert.equal(withBinding.total, without.total + 26);
        // String 'true' (form field) counts too; anything else does not.
        assert.equal(priceOrder([file(9, 1, 'single', 'bw')], { binding: 'true' }).bindingCharge, 26);
        assert.equal(priceOrder([file(9, 1, 'single', 'bw')], { binding: 'yes' }).bindingCharge, 0);
    });

    it('the printer still sees only the printing amount with binding and delivery on', () => {
        // 15 B&W pages = ₹30 printing; classroom delivery + binding are extras.
        const c = priceOrder([file(15, 1, 'single', 'bw')], { collectionLocationId: 'academic-block', classroomDelivery: true, binding: true });
        const order = itemisedOrder(c);
        assert.equal(toPrinterOrder(order).printer_payable, 30);
        assert.equal(financialBreakdown(order).summary.customerTotal, 30 + 5 + 26);
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
        binding_charge: charges.bindingCharge ? String(charges.bindingCharge) : null,
        ticket_access_token_hash: 'a'.repeat(64),
        ...extra
    };
}

describe('Printer Admin view', () => {
    const charges = priceOrder([file(10, 1, 'single', 'bw'), file(4, 2, 'double', 'color')], { collectionLocationId: 'hostel-gate' });
    const order = itemisedOrder(charges, { collection_location_id: 'hostel-gate' });
    const files = [
        { id: 1, order_id: 101, original_name: 'a.pdf', page_count: 10, copies: 1, printing_side: 'single', color_mode: 'bw', printing_charge: '20.00', storage_path: 'secret/a.pdf' },
        { id: 2, order_id: 101, original_name: 'b.pdf', page_count: 4, copies: 2, printing_side: 'double', color_mode: 'color', printing_charge: '120.00', storage_path: 'secret/b.pdf' }
    ];
    const view = toPrinterOrder(order, files);

    it('gets only the printing amount as printer payable', () => {
        assert.equal(view.printer_payable, 140);
        assert.equal(view.itemised, true);
    });

    it('never receives the customer total, extra charges or internal fields', () => {
        const json = JSON.stringify(view);
        for (const field of FORBIDDEN_FOR_PRINTER) assert.ok(!(field in view), `${field} leaked to printer`);
        assert.ok(!json.includes(String(charges.total)) || charges.total === 140, 'customer total value leaked');
        assert.ok(!json.includes('storage_path'));
    });

    it('sees per-file print settings and printing charges', () => {
        assert.deepEqual(view.files.map(f => [f.page_count, f.copies, f.printing_side, f.color_mode, f.printing_category, f.printing_charge]), [
            [10, 1, 'single', 'bw', 'BW_SINGLE', 20],
            [4, 2, 'double', 'color', 'COLOR_DOUBLE', 120]
        ]);
    });

    it('receives each file’s binding instruction and admin binding amount of ₹25', () => {
        const boundOrder = toPrinterOrder(order, [
            { ...files[0], spiral_binding: 1, binding_description: 'Front and back cover' },
            { ...files[1], spiral_binding: 0 }
        ]);
        assert.deepEqual(boundOrder.files.map(f => f.spiral_binding), [1, 0]);
        assert.equal(boundOrder.binding_status, 'Yes');
        assert.equal(boundOrder.binding_amount, 25);
        assert.equal(boundOrder.bound_pdf_count, 1);
        assert.equal(boundOrder.binding_description, 'Front and back cover');
        assert.equal(boundOrder.files[0].binding_description, 'Front and back cover');
    });

    it('provides all admin panel fields for binding and classroom delivery', () => {
        const orderWithBinding = itemisedOrder(charges, {
            collection_location: 'Academic Block - Classroom Delivery',
            classroom_charge: '5.00',
            guest_classroom: 'Room 302',
            binding_charge: '26.00',
            spiral_binding: 1
        });
        const adminOrder = toPrinterOrder(orderWithBinding, [
            { ...files[0], spiral_binding: 1, binding_description: 'Bind together with notes' }
        ]);
        assert.equal(adminOrder.classroom_delivery, true);
        assert.equal(adminOrder.classroom_number, 'Room 302');
        assert.equal(adminOrder.delivery_type, 'Classroom Delivery');
        assert.equal(adminOrder.binding_status, 'Yes');
        assert.equal(adminOrder.binding_amount, 25);
        assert.equal(adminOrder.bound_pdf_count, 1);
        assert.equal(adminOrder.binding_description, 'Bind together with notes');
        assert.equal(adminOrder.files[0].binding_description, 'Bind together with notes');
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
        const charges = basePriceOrder([file(15, 1, 'single', 'bw')], { classroomDelivery: true, binding: true });
        const order = itemisedOrder(charges, { collection_location_id: 'academic-block' });
        const payments = [
            { status: 'failed', amount: '63.00' },
            { status: 'success', amount: '63.00' }
        ];
        const b = financialBreakdown(order, [{ page_count: 15, copies: 1, printing_side: 'single', color_mode: 'bw', printing_charge: '30.00' }], payments);

        assert.equal(b.basis, 'ITEMISED');
        assert.equal(b.printing.totalPrinting, 30);
        assert.equal(b.printing.printerPayable, 30);
        assert.deepEqual(b.printing.lines.map(l => [l.category, l.printedPages, l.amount]), [['BW_SINGLE', 15, 30]]);
        // Classroom delivery ₹5 and binding ₹26.
        assert.deepEqual([b.extras.deliveryCharge, b.extras.serviceCharge, b.extras.classroomCharge, b.extras.bindingCharge, b.extras.totalExtras], [0, 2, 5, 26, 33]);
        assert.equal(b.summary.customerTotal, 63);
        assert.equal(b.summary.amountPaid, 63);
        assert.equal(b.summary.grossExtraRevenue, 33);
        assert.equal(b.deliveryLabel, 'Classroom Delivery');
        assert.equal(b.deliveryCharge, 5);
        assert.equal(b.reconciliation.reconciled, true);
        assert.equal(b.reconciliation.difference, 0);
    });

    it('flags saved charges that do not add up', () => {
        const charges = priceOrder([file(10, 1, 'single', 'bw')], {});
        const b = financialBreakdown(itemisedOrder(charges, { total_price: '99.00' }));
        assert.equal(b.reconciliation.reconciled, false);
        // ₹20 printing, no extras vs ₹99 saved.
        assert.equal(b.reconciliation.difference, 79);
        assert.ok(b.notes.some(n => n.includes('do not add up')));
    });

    it('legacy order is clearly ESTIMATED: total − service − Hostel Gate delivery', () => {
        const b = financialBreakdown({ id: 3, total_price: '210.00', printing_amount: null, collection_location_id: 'hostel-gate', payment_status: 'PAID' });
        assert.equal(b.basis, 'ESTIMATED');
        // Top service tier (₹3) + Hostel Gate ₹3 estimated for pre-itemised orders.
        assert.equal(b.printing.printerPayable, 204);
        assert.equal(b.extras.totalExtras, 6);
        assert.equal(b.extras.classroomCharge, null);
        assert.equal(b.extras.bindingCharge, null);
        assert.equal(b.reconciliation.reconciled, false);
    });

    it('legacy Academic Block order warns that classroom delivery may be inside the estimate', () => {
        const b = financialBreakdown({ id: 1, total_price: '38.00', printing_amount: null, collection_location_id: 'academic-block', payment_status: 'PAID' });
        assert.equal(b.printing.printerPayable, 35); // ₹38 − ₹3 top service tier
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
