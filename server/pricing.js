// Canonical order pricing — the single source of truth for what a customer pays and
// how that splits into the printer's printing charges vs Campus Print's extra charges.
// Keep the per-file rates in sync with filePrintingCost() in
// client-react/src/pages/NewOrder.jsx and Home.jsx (customer-side estimate only;
// the server's figure is always authoritative).

const PRICING = {
    single: 2,              // ₹ per page, B&W single-sided
    double: 3,              // ₹ per sheet (2 pages), B&W double-sided
    color: 5,               // ₹ per page, colour (either side)
    serviceCharge: 3,       // Campus Print service charge, every order
    hostelSurcharge: 3,     // Campus Print delivery charge to Hostel Gate
    classroomDelivery: 10   // Campus Print classroom delivery (Academic Block)
};

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
 *   serviceCharge, deliveryCharge (Hostel Gate), classroomCharge → Campus Print
 * Hostel Gate delivery and classroom delivery are mutually exclusive, as before.
 * Returns { printingAmount, fileCharges[], serviceCharge, deliveryCharge, classroomCharge, total }.
 */
function priceOrder(resolvedFiles, { collectionLocationId, classroomDelivery }) {
    if (!resolvedFiles || resolvedFiles.length === 0) {
        return { printingAmount: 0, fileCharges: [], serviceCharge: 0, deliveryCharge: 0, classroomCharge: 0, total: 0 };
    }
    const fileCharges = resolvedFiles.map(filePrintingCost);
    const printingAmount = fileCharges.reduce((sum, c) => sum + c, 0);
    const serviceCharge = PRICING.serviceCharge;
    let deliveryCharge = 0;
    let classroomCharge = 0;
    if (collectionLocationId === 'hostel-gate') {
        deliveryCharge = PRICING.hostelSurcharge;
    } else if (classroomDelivery === 'true' || classroomDelivery === true) {
        classroomCharge = PRICING.classroomDelivery;
    }
    return {
        printingAmount,
        fileCharges,
        serviceCharge,
        deliveryCharge,
        classroomCharge,
        total: printingAmount + serviceCharge + deliveryCharge + classroomCharge
    };
}

module.exports = { PRICING, filePrintingCost, priceOrder };
