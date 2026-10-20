// Canonical pricing for new orders. Historical charges remain below only for
// explaining orders created before the pricing update.
const PRICING = {
    single: 2,             // ₹ per page, B&W single-sided
    double: 3,             // ₹ per sheet (2 pages), B&W double-sided
    color: 5,              // ₹ per page, colour (either side)
    classroomDelivery: 5,  // ₹ per order
    binding: 26             // ₹ per document
};

const LEGACY_CHARGES = {
    serviceChargeTiers: [
        { upTo: 10, charge: 1 },
        { upTo: 30, charge: 2 },
        { upTo: Infinity, charge: 3 }
    ],
    hostelSurcharge: 3
};

/**
 * B&W double-sided printing is charged per physical sheet, rounded up per copy.
 * Colour and B&W single-sided printing are charged per printed page.
 */
function filePrintingCost(f) {
    const pages = Number(f.pages) || 0;
    const copies = Number(f.copies) || 1;
    if (f.colorMode === 'color') return pages * copies * PRICING.color;
    if (f.printingSide === 'double') return Math.ceil(pages / 2) * copies * PRICING.double;
    return pages * copies * PRICING.single;
}

/**
 * Prices server-resolved files. The order-level binding flag is accepted only
 * for compatibility with older clients that do not send per-file selections.
 */
function priceOrder(resolvedFiles, { classroomDelivery, binding } = {}) {
    if (!Array.isArray(resolvedFiles) || resolvedFiles.length === 0) {
        return { printingAmount: 0, fileCharges: [], printedPages: 0, serviceCharge: 0, deliveryCharge: 0, classroomCharge: 0, bindingCharge: 0, total: 0 };
    }
    const fileCharges = resolvedFiles.map(filePrintingCost);
    const printingAmount = fileCharges.reduce((sum, charge) => sum + charge, 0);
    const printedPages = resolvedFiles.reduce(
        (sum, file) => sum + (Number(file.pages) || 0) * (Number(file.copies) || 1), 0
    );
    const classroomCharge = classroomDelivery === 'true' || classroomDelivery === true
        ? PRICING.classroomDelivery
        : 0;
    const hasPerFileBinding = resolvedFiles.some(
        file => Object.prototype.hasOwnProperty.call(file, 'spiralBinding')
    );
    const bindingCount = hasPerFileBinding
        ? resolvedFiles.filter(file => file.spiralBinding === true || file.spiralBinding === 'true').length
        : (binding === true || binding === 'true' ? 1 : 0);
    const bindingCharge = bindingCount * PRICING.binding;

    return {
        printingAmount,
        fileCharges,
        printedPages,
        serviceCharge: 0,
        deliveryCharge: 0,
        classroomCharge,
        bindingCharge,
        total: printingAmount + classroomCharge + bindingCharge
    };
}

module.exports = { PRICING, LEGACY_CHARGES, filePrintingCost, priceOrder };
