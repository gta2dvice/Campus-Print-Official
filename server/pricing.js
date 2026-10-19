// Canonical order pricing — the single source of truth for what a customer pays and
// how that splits into the printer's printing charges vs Campus Print's extra charges.
// Keep the per-file rates in sync with filePrintingCost() in
// client-react/src/pages/NewOrder.jsx and Home.jsx (customer-side estimate only;
// the server's figure is always authoritative).

const PRICING = {
    single: 2,              // ₹ per page, B&W single-sided
    double: 3,              // ₹ per sheet (2 pages), B&W double-sided
    color: 5,               // ₹ per page, colour (either side)
    // Page-based service charge (by total printed pages = pages × copies):
    // 1–10 pages ₹1, 11–30 ₹2, 31+ ₹3 (the spec defines 31–100; ₹3 continues above 100).
    serviceChargeTiers: [
        { upTo: 10, charge: 1 },
        { upTo: 30, charge: 2 },
        { upTo: Infinity, charge: 3 }
    ],
    hostelSurcharge: 3,     // Campus Print delivery charge to Hostel Gate
    classroomDelivery: 5,   // Campus Print classroom delivery (Academic Block)
    binding: 25,            // Binding add-on (per ORDER — see priceOrder)
    bindingServiceCharge: 1 // Binding's own service charge (added ONCE, not per page tier)
};

/** Page-based service charge for the order's total printed pages. */
function serviceChargeForPages(printedPages) {
    const pages = Number(printedPages) || 0;
    for (const tier of PRICING.serviceChargeTiers) {
        if (pages <= tier.upTo) return tier.charge;
    }
    return PRICING.serviceChargeTiers[PRICING.serviceChargeTiers.length - 1].charge;
}

/**
 * Printing cost for one file. B&W double-sided is charged per physical sheet
 * (2 pages per sheet, rounded up per copy); B&W single-sided and colour stay per page.
 */
function filePrintingCost(f) {
    const pages = Number(f.pages) || 0;
    const copies = Number(f.copies) || 1;
    if (f.colorMode === 'color') return pages * copies * PRICING.color;
    if (f.printingSide === 'double') return Math.ceil(pages / 2) * copies * PRICING.double;
    return pages * copies * PRICING.single;
}

/**
 * Prices server-resolved files and splits the total:
 *   printingAmount  → printer's printing charges only
 *   serviceCharge (page-based), deliveryCharge (Hostel Gate), classroomCharge,
 *   bindingCharge (₹25 + ₹1 binding service charge, when requested) → Campus Print.
 * Hostel Gate delivery and classroom delivery are mutually exclusive, as before.
 *
 * Binding is an ORDER-level flag: the orders table carries one spiral_binding column
 * per order (not per file), so the ₹26 is charged ONCE per order regardless of how
 * many documents it contains.
 * Returns { printingAmount, fileCharges[], printedPages, serviceCharge, deliveryCharge,
 *           classroomCharge, bindingCharge, total }.
 */
function priceOrder(resolvedFiles, { collectionLocationId, classroomDelivery, binding } = {}) {
    if (!Array.isArray(resolvedFiles) || resolvedFiles.length === 0) {
        return { printingAmount: 0, fileCharges: [], printedPages: 0, serviceCharge: 0, deliveryCharge: 0, classroomCharge: 0, bindingCharge: 0, total: 0 };
    }
    const fileCharges = resolvedFiles.map(filePrintingCost);
    const printingAmount = fileCharges.reduce((sum, c) => sum + c, 0);
    const printedPages = resolvedFiles.reduce(
        (sum, f) => sum + (Number(f.pages) || 0) * (Number(f.copies) || 1), 0
    );
    const serviceCharge = serviceChargeForPages(printedPages);
    let deliveryCharge = 0;
    let classroomCharge = 0;
    if (collectionLocationId === 'hostel-gate') {
        deliveryCharge = PRICING.hostelSurcharge;
    } else if (classroomDelivery === 'true' || classroomDelivery === true) {
        classroomCharge = PRICING.classroomDelivery;
    }
    // Binding = ₹25 + ₹1 binding service charge. The ₹1 is separate from (and in
    // addition to) the page-based service charge — neither is counted twice.
    const bindingRequested = binding === true || binding === 'true';
    const bindingCharge = bindingRequested ? PRICING.binding + PRICING.bindingServiceCharge : 0;
    return {
        printingAmount,
        fileCharges,
        printedPages,
        serviceCharge,
        deliveryCharge,
        classroomCharge,
        bindingCharge,
        total: printingAmount + serviceCharge + deliveryCharge + classroomCharge + bindingCharge
    };
}

module.exports = { PRICING, serviceChargeForPages, filePrintingCost, priceOrder };
