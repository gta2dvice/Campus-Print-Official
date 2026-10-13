const crypto = require('crypto');
const pool = require('../db');
const otpService = require('../services/otp');

const OTP_TTL_MS = 10 * 60 * 1000;      // 10 minutes
const MAX_VERIFY_ATTEMPTS = 5;          // per OTP, before it locks

// Generates, stores (hashed), and returns a fresh OTP for a normalized phone.
async function createOtp(phone) {
    const otp = otpService.generateOtp();
    const otpHash = otpService.hashOtp(otp, phone);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    await pool.execute(
        `INSERT INTO order_recovery_otps (phone, otp_hash, expires_at) VALUES (?, ?, ?)`,
        [phone, otpHash, expiresAt]
    );
    return otp;
}

function hashesEqual(a, b) {
    const ba = Buffer.from(String(a || ''));
    const bb = Buffer.from(String(b || ''));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verifies an OTP against the latest unconsumed, unexpired row for the phone.
 * Returns { ok: true } or { ok: false, reason }.
 */
async function verifyOtp(phone, otp) {
    const [rows] = await pool.execute(
        `SELECT id, otp_hash, attempts FROM order_recovery_otps
         WHERE phone = ? AND consumed_at IS NULL AND expires_at > NOW()
         ORDER BY id DESC LIMIT 1`,
        [phone]
    );
    const record = rows[0];
    if (!record) return { ok: false, reason: 'expired' };
    if (record.attempts >= MAX_VERIFY_ATTEMPTS) return { ok: false, reason: 'locked' };

    const expectedHash = otpService.hashOtp(otp, phone);
    if (!hashesEqual(record.otp_hash, expectedHash)) {
        await pool.execute(`UPDATE order_recovery_otps SET attempts = attempts + 1 WHERE id = ?`, [record.id]);
        return { ok: false, reason: 'mismatch' };
    }

    await pool.execute(`UPDATE order_recovery_otps SET consumed_at = NOW() WHERE id = ?`, [record.id]);
    return { ok: true };
}

// Housekeeping: drop rows older than a day. Safe to call opportunistically.
async function cleanupExpired() {
    await pool.execute(`DELETE FROM order_recovery_otps WHERE expires_at < NOW() - INTERVAL '1 day'`);
}

module.exports = { createOtp, verifyOtp, cleanupExpired, OTP_TTL_MS, MAX_VERIFY_ATTEMPTS };
