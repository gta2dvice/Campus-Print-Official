// Role-specific financial views of an order. Pure functions (no DB) so they are
// easy to test; routes fetch the rows and pass them in.
//
//   Printer Admin → toPrinterOrder(): whitelisted order fields + printing charges only.
//                   Never the customer total, service / delivery / classroom charges.
//   Super Admin   → financialBreakdown(): printing (A), Campus Print extras (B) and the
//                   full summary (C), reconciled against the stored customer total.
//
// Amounts come from the charges saved on the order at creation (server/pricing.js).
// Orders created before itemising have no saved split: the printer sees them as
// "not itemised" and the Super Admin sees an estimate that is clearly labelled.
const { LEGACY_CHARGES } = require('../pricing');

function money(value) {
    return Math.round(Number(value) * 100) / 100;
}

function hasAmount(value) {
    return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function isItemised(order) {
    return hasAmount(order.printing_amount);
}

// Only these order fields ever reach the Printer Admin (whitelist, not blacklist,
// so a new money column can't leak by accident).
const PRINTER_ORDER_FIELDS = [
    'id', 'ticket_number', 'status', 'rejection_reason', 'created_at', 'shop_id', 'shop_name',
    'collection_location_id', 'collection_location', 'collection_time', 'collection_date',
    'paper_size', 'copies', 'file_count', 'total_pages', 'printing_side', 'color_option',
    'spiral_binding', 'express_delivery',
    'guest_full_name', 'guest_phone', 'guest_classroom',
    'customer_email', 'full_name', 'phone_number', 'class_room_number',
    'payment_status', 'payment_method', 'ticket_status'
];

const PRINTER_FILE_FIELDS = [
    'id', 'order_id', 'original_name', 'mime_type', 'size_bytes', 'file_type',
    'page_count', 'page_range', 'printing_side', 'copies', 'color_mode', 'spiral_binding',
    'binding_description', 'created_at', 'file_deleted_at'
];

function pick(source, fields) {
    const out = {};
    for (const field of fields) {
        if (source[field] !== undefined) out[field] = source[field];
    }
    return out;
}

function printingCategory(file) {
    const color = file.color_mode === 'color';
    const double = file.printing_side === 'double';
    if (color) return double ? 'COLOR_DOUBLE' : 'COLOR_SINGLE';
    return double ? 'BW_DOUBLE' : 'BW_SINGLE';
}

const CATEGORY_LABELS = {
    BW_SINGLE: 'Black & white, single-sided',
    BW_DOUBLE: 'Black & white, double-sided',
    COLOR_SINGLE: 'Colour, single-sided',
    COLOR_DOUBLE: 'Colour, double-sided'
};

/** One file as the printer sees it: print settings + its printing charge (if itemised). */
function toPrinterFile(file) {
    const view = pick(file, PRINTER_FILE_FIELDS);
    view.printing_category = printingCategory(file);
    view.printing_charge = hasAmount(file.printing_charge) ? money(file.printing_charge) : null;
    view.binding_description = file.binding_description || null;
    return view;
}

/**
 * Printer Admin view of an order: whitelisted fields, the printing amount payable
 * to the printer, and (when given) per-file printing details. No customer total,
 * no Campus Print charges.
 */
function toPrinterOrder(order, files) {
    const view = pick(order, PRINTER_ORDER_FIELDS);
    view.itemised = isItemised(order);
    view.printer_payable = view.itemised ? money(order.printing_amount) : null;
    if (files) view.files = files.map(toPrinterFile);

    // Delivery details for printer admin
    const isClassroom = (Number(order.classroom_charge) > 0) ||
        (order.collection_location === 'Academic Block - Classroom Delivery') ||
        (order.collection_location_id === 'classroom-delivery');
    view.classroom_delivery = isClassroom;
    view.classroom_number = order.guest_classroom || order.class_room_number || order.classroom_number || null;
    if (isClassroom) {
        view.delivery_type = 'Classroom Delivery';
    } else if (order.collection_location_id === 'hostel-gate' || Number(order.delivery_charge) > 0) {
        view.delivery_type = 'Hostel Gate Delivery';
    } else {
        view.delivery_type = 'Counter Pickup';
    }

    // Binding details for printer admin
    const boundFiles = files
        ? files.filter(f => f.spiral_binding === 1 || f.spiral_binding === true || f.spiralBinding === true)
        : [];
    const boundCount = boundFiles.length > 0
        ? boundFiles.reduce((sum, f) => sum + (Number(f.copies) || 1), 0)
        : (hasAmount(order.binding_charge) && Number(order.binding_charge) > 0
            ? Math.round(Number(order.binding_charge) / 26)
            : (!hasAmount(order.binding_charge) && order.spiral_binding ? (Number(order.copies) || 1) : 0));
    const isBinding = boundCount > 0;
    view.spiral_binding = isBinding ? 1 : 0;
    view.binding_status = isBinding ? 'Yes' : 'No';
    view.bound_pdf_count = isBinding ? boundCount : 0;
    // Include ₹25 in the admin's binding amount when selected. Customer binding remains ₹26.
    view.binding_amount = isBinding ? boundCount * 25 : 0;
    view.printing_subtotal = view.itemised ? money(order.printing_amount) : null;
    view.printing_charges = view.printing_subtotal;
    view.printer_payable = view.itemised ? money(Number(order.printing_amount) + view.binding_amount) : null;

    const descriptions = boundFiles
        .map(f => f.binding_description)
        .filter(Boolean);
    view.binding_description = descriptions.length > 0
        ? descriptions.join('; ')
        : (order.binding_description || null);

    view.pdf_count = order.file_count || (files ? files.length : 0);

    return view;
}

/** Printing lines grouped by category (pages × copies, amount when itemised). */
function printingLines(files) {
    const groups = {};
    for (const file of files) {
        const category = printingCategory(file);
        const group = groups[category] || (groups[category] = {
            category, label: CATEGORY_LABELS[category], files: 0, pages: 0, copies: 0, printedPages: 0, amount: 0, amountKnown: true
        });
        const pages = Number(file.page_count) || 0;
        const copies = Number(file.copies) || 1;
        group.files += 1;
        group.pages += pages;
        group.copies += copies;
        group.printedPages += pages * copies;
        if (hasAmount(file.printing_charge)) group.amount = money(group.amount + Number(file.printing_charge));
        else group.amountKnown = false;
    }
    return Object.values(groups).map(g => ({ ...g, amount: g.amountKnown ? g.amount : null }));
}

/**
 * Super Admin breakdown for one order.
 * @param order    orders row (total_price, printing_amount, service_charge, delivery_charge,
 *                 classroom_charge, collection_location_id, payment_status, …)
 * @param files    order_files rows
 * @param payments payments rows for the order (all attempts)
 */
function financialBreakdown(order, files = [], payments = []) {
    const customerTotal = money(order.total_price);
    const itemised = isItemised(order);
    const notes = [];

    let printing;
    let service;
    let delivery;
    let classroom;
    let binding;
    if (itemised) {
        printing = money(order.printing_amount);
        service = money(order.service_charge || 0);
        delivery = money(order.delivery_charge || 0);
        classroom = money(order.classroom_charge || 0);
        binding = hasAmount(order.binding_charge) ? money(order.binding_charge) : 0;
    } else {
        // Placed before charges were itemised: estimate with the current fixed charges.
        service = LEGACY_CHARGES.serviceChargeTiers[LEGACY_CHARGES.serviceChargeTiers.length - 1].charge;
        delivery = order.collection_location_id === 'hostel-gate' ? LEGACY_CHARGES.hostelSurcharge : 0;
        classroom = null; // not recorded on old orders — cannot be told apart
        binding = null;   // binding was not priced on old orders
        const estimate = money(customerTotal - service - delivery);
        printing = estimate >= 0 ? estimate : null;
        notes.push('Estimated: this order was placed before charges were itemised. Printing = customer total − service charge − Hostel Gate delivery.');
        if (order.collection_location_id === 'academic-block') {
            notes.push('Classroom delivery (₹5) was not recorded on old orders; for this Academic Block order it may be included in the printing estimate.');
        }
        if (printing === null) notes.push('The customer total is lower than the fixed charges, so printing cannot be estimated.');
    }

    const extrasTotal = money(service + delivery + (classroom || 0) + (binding || 0));
    const successful = payments.find(p => p.status === 'success');
    const refundedAmount = money(payments.filter(p => p.status === 'refunded').reduce((sum, p) => sum + Number(p.amount || 0), 0));
    const amountPaid = successful ? money(successful.amount) : (order.payment_status === 'PAID' && refundedAmount === 0 ? customerTotal : 0);
    const paymentStatus = refundedAmount > 0 && !successful ? 'REFUNDED' : (order.payment_status || 'PAYMENT_PENDING');

    const expectedTotal = printing === null ? null : money(printing + extrasTotal);
    const difference = expectedTotal === null ? null : money(customerTotal - expectedTotal);
    const reconciled = itemised && difference !== null && Math.abs(difference) < 0.01;
    if (itemised && !reconciled) {
        notes.push(`Saved charges do not add up to the customer total (difference ₹${difference}). Check this order.`);
    }

    const deliveryType = classroom > 0 ? 'classroom' : (delivery > 0 ? 'hostel' : 'pickup');
    const deliveryLabel = classroom > 0 ? 'Classroom Delivery' : (delivery > 0 ? 'Hostel Gate Delivery' : 'Counter Pickup');
    const activeDeliveryCharge = classroom > 0 ? classroom : (delivery > 0 ? delivery : 0);

    // Bound copy calculation:
    // Customer binding is ₹26/copy; printer binding payout is ₹25/copy; Campus Print retains ₹1/copy.
    const boundFiles = files
        ? files.filter(f => f.spiral_binding === 1 || f.spiral_binding === true || f.spiralBinding === true)
        : [];
    const boundCount = boundFiles.length > 0
        ? boundFiles.reduce((sum, f) => sum + (Number(f.copies) || 1), 0)
        : (binding && binding > 0
            ? Math.round(binding / 26)
            : (order.spiral_binding ? (Number(order.copies) || 1) : 0));

    const printerBinding = itemised ? (boundCount * 25) : null;
    const printerPayable = printing === null ? null : money(printing + (printerBinding || 0));

    return {
        basis: itemised ? 'ITEMISED' : 'ESTIMATED',
        deliveryType,
        deliveryLabel,
        deliveryCharge: activeDeliveryCharge,
        printing: {
            lines: printingLines(files),
            totalPrinting: printing,
            printerBinding,
            printerPayable
        },
        extras: {
            deliveryCharge: delivery,
            serviceCharge: service,
            classroomCharge: classroom,
            bindingCharge: binding,
            customerBinding: binding,
            printerBinding,
            campusPrintBinding: (binding !== null && printerBinding !== null) ? money(binding - printerBinding) : null,
            otherCharges: 0,
            totalExtras: extrasTotal
        },
        summary: {
            totalPrinting: printing,
            totalDelivery: delivery,
            totalService: service,
            totalClassroom: classroom,
            totalBinding: binding,
            customerBinding: binding,
            printerBinding,
            boundCount,
            deliveryType,
            deliveryLabel,
            deliveryCharge: activeDeliveryCharge,
            customerTotal,
            amountPaid,
            refundedAmount,
            printerPayable,
            grossExtraRevenue: extrasTotal,
            paymentStatus
        },
        reconciliation: { expectedTotal, customerTotal, difference, reconciled },
        notes
    };
}

module.exports = {
    toPrinterOrder,
    toPrinterFile,
    financialBreakdown,
    isItemised,
    PRINTER_ORDER_FIELDS
};
