const crypto = require('crypto');
const pool = require('../db');
const otpService = require('../services/otp');
const { normalizeEmail } = require('../email');

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_VERIFY_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

function hashesEqual(first, second) {
    const a = Buffer.from(String(first || ''));
    const b = Buffer.from(String(second || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function checkCooldown(rawEmail) {
    const email = normalizeEmail(rawEmail);
    if (!email) return { inCooldown: false, remainingSeconds: 0 };

    try {
        const [rows] = await pool.query(
            `SELECT created_at
             FROM order_recovery_otps
             WHERE LOWER(COALESCE(email, '')) = ?
               AND consumed_at IS NULL
               AND created_at > NOW() - ($1 || ' milliseconds')::interval
             ORDER BY id DESC LIMIT 1`,
            [email, String(RESEND_COOLDOWN_MS)]
        );
        const record = rows[0];
        if (!record) return { inCooldown: false, remainingSeconds: 0 };

        const elapsedMs = Date.now() - new Date(record.created_at).getTime();
        const remainingMs = Math.max(0, RESEND_COOLDOWN_MS - elapsedMs);
        const remainingSeconds = Math.ceil(remainingMs / 1000);
        return {
            inCooldown: remainingSeconds > 0,
            remainingSeconds
        };
    } catch {
        return { inCooldown: false, remainingSeconds: 0 };
    }
}

async function createOtp(rawEmail) {
    const email = normalizeEmail(rawEmail);
    if (!email) throw new Error('Invalid email address for recovery OTP');

    const otp = otpService.generateOtp();
    const otpHash = otpService.hashOtp(otp, email);
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    let otpId;

    await pool.transaction(async tx => {
        // Invalidate older unconsumed active codes for this email
        await tx.execute(
            `UPDATE order_recovery_otps
             SET consumed_at = NOW()
             WHERE LOWER(COALESCE(email, '')) = ? AND consumed_at IS NULL`,
            [email]
        );
        const [result] = await tx.execute(
            `INSERT INTO order_recovery_otps (email, otp_hash, expires_at)
             VALUES (?, ?, ?)`,
            [email, otpHash, expiresAt]
        );
        otpId = result.insertId;
    });

    return { id: otpId, otp };
}

async function verifyOtp(rawEmail, otp) {
    const email = normalizeEmail(rawEmail);
    if (!email) return { ok: false, reason: 'expired' };

    return pool.transaction(async tx => {
        const [rows] = await tx.query(
            `SELECT id, otp_hash, attempts
             FROM order_recovery_otps
             WHERE LOWER(COALESCE(email, '')) = ? AND consumed_at IS NULL AND expires_at > NOW()
             ORDER BY id DESC LIMIT 1 FOR UPDATE`,
            [email]
        );
        const record = rows[0];
        if (!record) return { ok: false, reason: 'expired' };
        if (record.attempts >= MAX_VERIFY_ATTEMPTS) return { ok: false, reason: 'locked' };

        const expectedHash = otpService.hashOtp(otp, email);
        if (!hashesEqual(record.otp_hash, expectedHash)) {
            const nextAttempts = record.attempts + 1;
            await tx.execute(
                `UPDATE order_recovery_otps SET attempts = ? WHERE id = ?`,
                [nextAttempts, record.id]
            );
            return {
                ok: false,
                reason: nextAttempts >= MAX_VERIFY_ATTEMPTS ? 'locked' : 'mismatch',
                attemptsLeft: Math.max(0, MAX_VERIFY_ATTEMPTS - nextAttempts)
            };
        }

        // Single-use: mark as consumed immediately upon successful verification
        await tx.execute(
            `UPDATE order_recovery_otps SET consumed_at = NOW() WHERE id = ? AND consumed_at IS NULL`,
            [record.id]
        );
        return { ok: true };
    });
}

async function invalidateOtp(id) {
    if (!id) return;
    await pool.execute(
        `UPDATE order_recovery_otps SET consumed_at = NOW()
         WHERE id = ? AND consumed_at IS NULL`,
        [id]
    );
}

async function cleanupExpired() {
    await pool.execute(
        `DELETE FROM order_recovery_otps WHERE expires_at < NOW() - INTERVAL '1 day'`
    );
    await pool.execute(
        `DELETE FROM rate_limits WHERE window_start < NOW() - INTERVAL '1 day'`
    );
}

module.exports = {
    createOtp,
    verifyOtp,
    checkCooldown,
    invalidateOtp,
    cleanupExpired,
    OTP_TTL_MS,
    MAX_VERIFY_ATTEMPTS,
    RESEND_COOLDOWN_MS
};
