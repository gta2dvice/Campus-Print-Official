// Phone handling shared across recovery endpoints.
// Checkout validates and stores a bare 10-digit Indian mobile (^[6-9][0-9]{9}$),
// so recovery normalization must produce the same canonical form for lookups.

function normalizePhone(raw) {
    if (!raw) return null;
    const digits = String(raw).replace(/\D/g, '');
    const last10 = digits.slice(-10);
    if (!/^[6-9][0-9]{9}$/.test(last10)) return null;
    return last10;
}

// Never log or render a full phone number. 98****3210 style mask.
function maskPhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    const p = digits.length >= 10 ? digits.slice(-10) : digits;
    if (p.length < 4) return '****';
    return `${p.slice(0, 2)}****${p.slice(-2)}`;
}

module.exports = { normalizePhone, maskPhone };
