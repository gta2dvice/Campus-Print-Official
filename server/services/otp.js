// OTP service with a deliberate provider seam.
//
// The project intentionally has NO SMS/WhatsApp provider wired up yet. When one
// is added later, implement delivery inside sendOtp() — nothing else needs to
// change. Until then:
//   • development / sandbox: the OTP is surfaced so the flow is testable.
//   • production: the OTP is NEVER returned or logged in plaintext; recovery is
//     effectively inert until a real provider is configured.
const crypto = require('crypto');
const { maskPhone } = require('../phone');

function isProduction() {
    return process.env.NODE_ENV === 'production';
}

// 6-digit OTP, cryptographically random, no modulo bias.
function generateOtp() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

// HMAC so a leaked DB row never reveals the OTP; bound to the phone so a hash
// can't be replayed against a different number.
function hashOtp(otp, phone) {
    const secret = process.env.SESSION_SECRET || 'campus-print-secret';
    return crypto.createHmac('sha256', secret).update(`${phone}:${otp}`).digest('hex');
}

/**
 * "Delivers" the OTP. Returns { delivered, devOtp }.
 * devOtp is populated ONLY outside production, and is what the dev-mode API
 * response echoes back for local/sandbox testing.
 */
async function sendOtp(phone, otp) {
    if (isProduction()) {
        // No provider configured — do not leak the OTP anywhere.
        console.info('[OTP_SEND] Recovery OTP requested (no delivery provider configured in production).');
        return { delivered: false, devOtp: null };
    }
    console.info(`[OTP_DEV] Recovery OTP for ${maskPhone(phone)}: ${otp}`);
    return { delivered: true, devOtp: otp };
}

module.exports = { isProduction, generateOtp, hashOtp, sendOtp };
