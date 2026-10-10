// UPI QR helpers for the "Pay via UPI QR" method.
//
// Verification note: a plain upi://pay QR to a VPA has NO programmatic payment
// status. This module only builds the reference + URI + QR image; confirming the
// payment is a manual step (the shop admin marks the order paid).
const crypto = require('crypto');
const QRCode = require('qrcode');

// Cryptographically-secure, order-scoped reference, e.g. CP-1048-8A92F31C.
// Uniqueness is additionally enforced by a UNIQUE index on payments.payment_reference.
function generatePaymentReference(orderId) {
    const rand = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 hex chars
    return `CP-${orderId}-${rand}`;
}

// Builds a UPI deep link / QR payload. Amount is formatted to 2 decimals.
// Only non-secret, payment-facing values go in here.
function buildUpiUri({ vpa, payeeName, amount, reference, note }) {
    if (!vpa) throw new Error('Missing merchant UPI VPA');
    const params = new URLSearchParams({
        pa: vpa,
        pn: payeeName || 'Campus Print',
        am: Number(amount).toFixed(2),
        cu: 'INR',
        tr: reference,
        tn: note || `Campus Print ${reference}`
    });
    // URLSearchParams encodes spaces as '+'; UPI apps expect %20.
    return `upi://pay?${params.toString().replace(/\+/g, '%20')}`;
}

async function generateQrDataUrl(uri) {
    return QRCode.toDataURL(uri, { errorCorrectionLevel: 'M', margin: 1, width: 320 });
}

module.exports = { generatePaymentReference, buildUpiUri, generateQrDataUrl };
