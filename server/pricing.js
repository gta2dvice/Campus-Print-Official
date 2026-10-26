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
 * Prices server-resolved files using the copy-based pricing model:
 * Each copy is a separately priced instance where printing subtotal,
 * service charge, and applicable binding are calculated per copy and multiplied by copies.
 *
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
    const deliveryCharge = classroomCharge > 0
        ? 0
        : (collectionLocationId === 'hostel-gate' ? PRICING.hostelDelivery : 0);

    const hasPerFileBinding = resolvedFiles.some(
        file => Object.prototype.hasOwnProperty.call(file, 'spiralBinding')
    );

    let bindingCharge = 0;
    let serviceCharge = 0;

    if (hasPerFileBinding) {
        // Modern per-file, per-copy model:
        // Each copy is a separately priced instance:
        // Service and binding charges are calculated per copy and multiplied by copies.
        for (const file of resolvedFiles) {
            const pages = Number(file.pages) || 0;
            const copies = Number(file.copies) || 1;
            if (pages <= 0) continue;

            if (includeServiceCharge) {
                const tier = SERVICE_CHARGE_TIERS.find(t => pages <= t.upTo);
                const servicePerCopy = tier ? tier.charge : 0;
                serviceCharge += servicePerCopy * copies;
            }

            const isBindingEligible =
                (file.spiralBinding === true || file.spiralBinding === 'true') && pages >= 5;
            if (isBindingEligible) {
                const bindingPerCopy = PRICING.binding + PRICING.bindingServiceFee;
                bindingCharge += bindingPerCopy * copies;
            }
        }
    } else {
        // Legacy fallback when per-file spiralBinding property is absent:
        if (includeServiceCharge) {
            for (const file of resolvedFiles) {
                const pages = Number(file.pages) || 0;
                const copies = Number(file.copies) || 1;
                if (pages <= 0) continue;
                const tier = SERVICE_CHARGE_TIERS.find(t => pages <= t.upTo);
                const servicePerCopy = tier ? tier.charge : 0;
                serviceCharge += servicePerCopy * copies;
            }
        }
        const legacyBindingEligible = (binding === true || binding === 'true') && (Number(resolvedFiles[0]?.pages) >= 5);
        if (legacyBindingEligible) {
            const copies = Number(resolvedFiles[0]?.copies) || 1;
            bindingCharge = (PRICING.binding + PRICING.bindingServiceFee) * copies;
        }
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
