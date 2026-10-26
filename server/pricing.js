// Canonical pricing for new orders. Historical charges remain below only for
// explaining orders created before the pricing update.
const PRICING = {
    single: 2,             // ₹ per page, B&W single-sided
    double: 3,             // ₹ per page, B&W double-sided
    colorSingle: 12,       // ₹ per page, colour single-sided
    colorDouble: 15,       // ₹ per page, colour double-sided
    classroomDelivery: 5,  // ₹ per order
    hostelDelivery: 3,     // ₹ per order (Hostel Gate delivery surcharge)
    binding: 25,            // ₹ per selected document
    bindingServiceFee: 1    // ₹ per selected document
};

const SERVICE_CHARGE_TIERS = [
    { upTo: 10, charge: 1 },
    { upTo: 30, charge: 2 },
    { upTo: Infinity, charge: 3 }
];

const LEGACY_CHARGES = {
    serviceChargeTiers: SERVICE_CHARGE_TIERS,
    hostelSurcharge: 3
};

/**
 * Printing is charged per billable page (page count × copies). The service
 * charge is separately applied once per order by priceOrder().
 */
function filePrintingCost(f) {
    const pages = Number(f.pages) || 0;
    const copies = Number(f.copies) || 1;
    if (f.colorMode === 'color') {
        return pages * copies * (f.printingSide === 'double' ? PRICING.colorDouble : PRICING.colorSingle);
    }
    if (f.printingSide === 'double') return pages * copies * PRICING.double;
    return pages * copies * PRICING.single;
}

/**
 * Prices server-resolved files.
 * @param {boolean} includeServiceCharge - Whether to include the tiered service charge.
 */
function priceOrder(resolvedFiles, { collectionLocationId, classroomDelivery, binding, includeServiceCharge = true } = {}) {
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
    const deliveryCharge = collectionLocationId === 'hostel-gate'
        ? PRICING.hostelDelivery
        : 0;
    const hasPerFileBinding = resolvedFiles.some(
        file => Object.prototype.hasOwnProperty.call(file, 'spiralBinding')
    );
    const bindingCount = hasPerFileBinding
        ? resolvedFiles.filter(file => (file.spiralBinding === true || file.spiralBinding === 'true') && (Number(file.pages) >= 5)).length
        : (binding === true || binding === 'true' ? (resolvedFiles[0]?.pages >= 5 ? 1 : 0) : 0);
    const bindingCharge = bindingCount * (PRICING.binding + PRICING.bindingServiceFee);

    let serviceCharge = 0;
    if (includeServiceCharge) {
        const tier = SERVICE_CHARGE_TIERS.find(t => printedPages <= t.upTo);
        serviceCharge = tier ? tier.charge : 0;
    }

    return {
        printingAmount,
        fileCharges,
        printedPages,
        serviceCharge,
        deliveryCharge,
        classroomCharge,
        bindingCharge,
        total: printingAmount + classroomCharge + deliveryCharge + bindingCharge + serviceCharge
    };
}

module.exports = { PRICING, SERVICE_CHARGE_TIERS, LEGACY_CHARGES, filePrintingCost, priceOrder };
