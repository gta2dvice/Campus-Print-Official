const { Resend } = require('resend');
const { maskEmail } = require('../email');

class EmailDeliveryError extends Error {
    constructor(code, status, message) {
        super(message);
        this.name = 'EmailDeliveryError';
        this.code = code;
        this.status = status;
    }
}

function isProduction() {
    return process.env.NODE_ENV === 'production';
}

function getResendConfig() {
    const apiKey = process.env.RESEND_API_KEY?.trim();
    const fromEmail = process.env.RESEND_FROM_EMAIL?.trim();
    if (!apiKey) return null;
    return {
        apiKey,
        fromEmail: fromEmail || 'Campus Print <onboarding@resend.dev>'
    };
}

let cachedResendInstance = null;
let cachedApiKey = null;

function getResendClient(apiKey) {
    if (cachedResendInstance && cachedApiKey === apiKey) {
        return cachedResendInstance;
    }
    cachedResendInstance = new Resend(apiKey);
    cachedApiKey = apiKey;
    return cachedResendInstance;
}

function sanitizeErrorDiagnostic(err) {
    const raw = String(err?.message || err?.name || 'Unknown email delivery error');
    const apiKey = process.env.RESEND_API_KEY?.trim();
    let sanitized = raw;
    if (apiKey) {
        sanitized = sanitized.split(apiKey).join('[redacted]');
    }
    return sanitized
        .replace(/re_[a-zA-Z0-9_-]+/g, '[redacted]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
        .slice(0, 200);
}

/**
 * Reusable email service sending through official Resend SDK.
 *
 * @param {Object} options
 * @param {string} options.to - Destination email address
 * @param {string} options.subject - Email subject
 * @param {string} options.html - HTML body
 * @param {string} [options.text] - Plain text fallback
 * @returns {Promise<{ delivered: boolean, messageId?: string, provider: string }>}
 */
async function sendEmail({ to, subject, html, text }) {
    const config = getResendConfig();

    if (!config) {
        if (!isProduction()) {
            return {
                delivered: true,
                messageId: `dev-${Date.now()}`,
                provider: 'development'
            };
        }
        throw new EmailDeliveryError(
            'EMAIL_PROVIDER_NOT_CONFIGURED',
            503,
            'Email delivery is temporarily unavailable. Please try again later.'
        );
    }

    const resend = getResendClient(config.apiKey);

    let result;
    try {
        result = await resend.emails.send({
            from: config.fromEmail,
            to,
            subject,
            html,
            text: text || html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
        });
    } catch (networkError) {
        console.error('[EMAIL_DELIVERY_NETWORK_ERROR]', {
            maskedTo: maskEmail(to),
            error: sanitizeErrorDiagnostic(networkError)
        });
        throw new EmailDeliveryError(
            'EMAIL_PROVIDER_UNAVAILABLE',
            503,
            'We could not reach the email service. Please try again shortly.'
        );
    }

    if (result.error) {
        const errorName = String(result.error.name || '').toLowerCase();
        const statusCode = result.error.statusCode || (errorName.includes('rate_limit') ? 429 : 503);
        const errorCode = errorName.includes('rate_limit')
            ? 'EMAIL_PROVIDER_RATE_LIMITED'
            : 'EMAIL_PROVIDER_REJECTED';

        console.warn('[EMAIL_DELIVERY_REJECTED]', {
            maskedTo: maskEmail(to),
            code: errorCode,
            status: statusCode,
            error: sanitizeErrorDiagnostic(result.error)
        });

        const clientMessage = statusCode === 429
            ? 'Too many email requests. Please wait a moment before trying again.'
            : 'The email service could not deliver your verification code. Please try again later.';

        throw new EmailDeliveryError(errorCode, statusCode, clientMessage);
    }

    return {
        delivered: true,
        messageId: result.data?.id || null,
        provider: 'resend'
    };
}

module.exports = {
    sendEmail,
    EmailDeliveryError,
    getResendConfig,
    isProduction
};
