// Fixed-window rate limiting.
//
// Primary store is the DB (rate_limits table) so limits hold across serverless
// invocations (Vercel), where per-process memory would not persist. If the DB
// counter errors, we fall back to an in-memory window so local/dev still throttles.
const crypto = require('crypto');
const db = require('../db');

const memoryBuckets = new Map(); // bucket -> { count, windowStart }

function clientIp(req) {
    const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return fwd || req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

async function hitDb(bucket, windowMs, max) {
    // Atomic upsert: reset the counter when the stored window has elapsed,
    // otherwise increment it. Uses the raw pg pool so RETURNING is readable
    // (the mysql-style adapter discards rows for INSERTs).
    const sql = `
        INSERT INTO rate_limits (bucket, count, window_start)
        VALUES ($1, 1, NOW())
        ON CONFLICT (bucket) DO UPDATE SET
            count = CASE WHEN rate_limits.window_start < NOW() - ($2 || ' milliseconds')::interval
                         THEN 1 ELSE rate_limits.count + 1 END,
            window_start = CASE WHEN rate_limits.window_start < NOW() - ($2 || ' milliseconds')::interval
                         THEN NOW() ELSE rate_limits.window_start END
        RETURNING count`;
    const result = await db.pool.query(sql, [bucket, String(windowMs)]);
    const count = Number(result.rows[0]?.count || 1);
    return count <= max;
}

function hitMemory(bucket, windowMs, max) {
    const now = Date.now();
    const entry = memoryBuckets.get(bucket);
    if (!entry || now - entry.windowStart >= windowMs) {
        memoryBuckets.set(bucket, { count: 1, windowStart: now });
        return 1 <= max;
    }
    entry.count += 1;
    return entry.count <= max;
}

/**
 * rateLimit({ prefix, windowMs, max, key }) → Express middleware.
 *   prefix  – label for this limiter (e.g. 'otp-lookup')
 *   key(req) – optional extra key component (e.g. normalized phone) so abuse of
 *              a single target is throttled independently of the source IP.
 */
function rateLimit({ prefix, windowMs, max, key }) {
    return async function rateLimitMiddleware(req, res, next) {
        const extra = typeof key === 'function' ? (key(req) || '') : '';
        const bucket = `${prefix}:${clientIp(req)}${extra ? `:${extra}` : ''}`;
        let allowed;
        try {
            allowed = await hitDb(bucket, windowMs, max);
        } catch (error) {
            console.warn('[RATE_LIMIT_STORAGE_UNAVAILABLE]', {
                code: String(error.code || 'RATE_LIMIT_STORAGE_ERROR')
                    .replace(/[^A-Za-z0-9_-]/g, '')
                    .slice(0, 64)
            });
            allowed = hitMemory(bucket, windowMs, max);
        }
        if (!allowed) {
            return res.status(429).json({
                message: 'Too many requests. Please wait a little and try again.',
                code: 'RATE_LIMITED'
            });
        }
        return next();
    };
}

function phoneRateLimitKey(phone) {
    const secret = process.env.SESSION_SECRET || 'campus-print-secret';
    return crypto.createHmac('sha256', secret).update(String(phone || '')).digest('hex').slice(0, 24);
}

function emailRateLimitKey(email) {
    const normalized = String(email || '').trim().toLowerCase();
    const secret = process.env.SESSION_SECRET || 'campus-print-secret';
    return crypto.createHmac('sha256', secret).update(normalized).digest('hex').slice(0, 24);
}

module.exports = { rateLimit, phoneRateLimitKey, emailRateLimitKey };
