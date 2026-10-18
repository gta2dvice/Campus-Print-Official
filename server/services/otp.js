const crypto = require('crypto');
const emailService = require('./emailService');
const { EmailDeliveryError } = emailService;

class OtpDeliveryError extends Error {
    constructor(code, status, message) {
        super(message);
        this.name = 'OtpDeliveryError';
        this.code = code;
        this.status = status;
    }
}

function isProduction() {
    return process.env.NODE_ENV === 'production';
}

function providerConfig() {
    return emailService.getResendConfig();
}

function generateOtp() {
    return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashOtp(otp, email) {
    const secret = process.env.SESSION_SECRET || 'campus-print-secret';
    const normalized = String(email || '').trim().toLowerCase();
    return crypto.createHmac('sha256', secret).update(`${normalized}:${otp}`).digest('hex');
}

function buildOtpHtml(otp) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Campus Print Verification Code</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #f8fafc; padding: 30px 15px;">
    <tr>
      <td align="center">
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 500px; background: #ffffff; border-radius: 12px; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.05); overflow: hidden;">
          <!-- Header -->
          <tr>
            <td style="background-color: #1e3a8a; padding: 24px 30px; text-align: center;">
              <h1 style="margin: 0; color: #ffffff; font-size: 20px; font-weight: 700; letter-spacing: 0.5px;">Campus Print</h1>
            </td>
          </tr>
          <!-- Body -->
          <tr>
            <td style="padding: 32px 30px 24px;">
              <h2 style="margin: 0 0 12px; font-size: 18px; font-weight: 600; color: #0f172a;">Verify your identity</h2>
              <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.6; color: #475569;">
                Use the verification code below to access your Campus Print orders and tickets.
              </p>
              <!-- Code Box -->
              <div style="background-color: #f1f5f9; border-radius: 8px; padding: 18px; text-align: center; margin: 24px 0;">
                <span style="font-family: 'Courier New', Courier, monospace; font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #1e3a8a; display: inline-block;">
                  ${otp}
                </span>
              </div>

              <p style="margin: 0 0 16px; font-size: 13px; color: #64748b; text-align: center;">
                ⏳ This code expires in <strong>5 minutes</strong>.
              </p>

              <!-- Security notice -->
              <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; border-radius: 4px; padding: 12px 14px; margin-top: 24px;">
                <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #991b1b;">
                  <strong>Security notice:</strong> Do not share this code with anyone. Campus Print staff will never ask for your verification code.
                </p>
              </div>

              <p style="margin: 20px 0 0; font-size: 12px; line-height: 1.5; color: #94a3b8;">
                If you did not request this verification code, you can safely disregard this email.
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="background-color: #f8fafc; border-top: 1px solid #e2e8f0; padding: 16px 30px; text-align: center;">
              <p style="margin: 0; font-size: 11px; color: #94a3b8;">
                &copy; ${new Date().getFullYear()} Campus Print. Fast, reliable campus printing.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();
}

function buildOtpText(otp) {
    return [
        'Campus Print - Verification Code',
        '--------------------------------',
        '',
        `Your verification code is: ${otp}`,
        '',
        'This code will expire in 5 minutes.',
        '',
        'SECURITY NOTICE:',
        'Do not share this code with anyone. Campus Print staff will never ask for your verification code.',
        '',
        'If you did not request this code, you can safely disregard this email.'
    ].join('\n');
}

/**
 * Sends a 6-digit recovery OTP to the student's email address using Resend.
 *
 * @param {string} email
 * @param {string} otp
 * @returns {Promise<{ delivered: boolean, devOtp: string|null, provider: string }>}
 */
async function sendOtp(email, otp) {
    const config = providerConfig();
    if (!config) {
        if (!isProduction()) {
            return { delivered: true, devOtp: otp, provider: 'development' };
        }
        throw new OtpDeliveryError(
            'OTP_PROVIDER_NOT_CONFIGURED',
            503,
            'Verification emails are temporarily unavailable. Please try again later.'
        );
    }

    try {
        const result = await emailService.sendEmail({
            to: email,
            subject: `${otp} is your Campus Print verification code`,
            html: buildOtpHtml(otp),
            text: buildOtpText(otp)
        });

        return {
            delivered: result.delivered,
            devOtp: result.provider === 'development' ? otp : null,
            provider: result.provider
        };
    } catch (err) {
        if (err instanceof EmailDeliveryError) {
            throw new OtpDeliveryError(err.code, err.status, err.message);
        }
        throw new OtpDeliveryError(
            'OTP_PROVIDER_UNAVAILABLE',
            503,
            'We could not send your verification code. Please try again shortly.'
        );
    }
}

module.exports = {
    isProduction,
    providerConfig,
    generateOtp,
    hashOtp,
    sendOtp,
    OtpDeliveryError,
    buildOtpHtml,
    buildOtpText
};
