const pool = require('../db');
const Order = require('../models/Order');
const emailService = require('./emailService');
const { generateTicketPdf } = require('./ticketPdfGenerator');
const { normalizeEmail, maskEmail } = require('../email');
const { maskPhone } = require('../phone');
const { createTicketToken, isValidTicketToken } = require('../ticketTokens');

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function sanitizeDiagnostic(msg) {
    if (!msg) return null;
    const apiKey = process.env.RESEND_API_KEY?.trim();
    let sanitized = String(msg);
    if (apiKey) sanitized = sanitized.split(apiKey).join('[redacted]');
    return sanitized
        .replace(/re_[a-zA-Z0-9_-]+/g, '[redacted]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
        .slice(0, 250);
}

function getFrontendUrl() {
    return (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
}

/**
 * Resolves the secure view link for a ticket:
 * If it's a Cashfree order and the token matches the stored hash, returns /ticket?token=...
 * Otherwise falls back to /orders (recovery portal).
 */
async function resolveTicketUrl(order) {
    const frontend = getFrontendUrl();
    if (!order) return `${frontend}/orders`;

    try {
        if (order.ticket_access_token_hash) {
            const attempt = await Order.getLatestCashfreeAttempt(order.id);
            if (attempt?.gateway_order_id) {
                const token = createTicketToken(attempt.gateway_order_id);
                if (isValidTicketToken(token, order.ticket_access_token_hash)) {
                    return `${frontend}/ticket?token=${encodeURIComponent(token)}`;
                }
            }
        }
    } catch {
        // Fallback to Orders page
    }
    return `${frontend}/orders`;
}

function formatDate(val) {
    if (!val) return '—';
    try {
        const d = new Date(val);
        if (Number.isNaN(d.getTime())) return String(val);
        return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
        return String(val);
    }
}

/**
 * Builds the branded Campus Print HTML email body.
 */
function buildTicketEmailHtml({ order, ticketNumber, ticketUrl, transactionRef }) {
    const displayName = escapeHtml(order.guest_full_name || (order.customer_email ? order.customer_email.split('@')[0] : 'Student'));
    const orderDate = escapeHtml(formatDate(order.created_at));
    const collectionDate = escapeHtml(formatDate(order.collection_date || order.created_at));
    const collectionLocation = escapeHtml(order.collection_location || 'Campus Pickup Counter');
    const collectionTime = escapeHtml(order.collection_time || 'Designated Slot');
    const totalPrice = Number(order.total_price || 0).toFixed(2);
    const fileCount = escapeHtml(order.file_count || 1);
    const totalPages = escapeHtml(order.total_pages || '—');
    const paperSize = escapeHtml(order.paper_size || 'A4');
    const side = order.printing_side === 'double' ? 'Double-sided' : 'Single-sided';
    const maskedPhone = escapeHtml(maskPhone(order.guest_phone));
    const safeTicketNumber = escapeHtml(ticketNumber);
    const safeOrderId = escapeHtml(order.id);
    const safeTicketUrl = escapeHtml(ticketUrl);
    const safeTransactionRef = escapeHtml(transactionRef);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Campus Print Ticket — ${safeTicketNumber}</title>
</head>
<body style="margin:0;padding:0;background-color:#0b0f19;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#f1f5f9;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#0b0f19;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:600px;background-color:#131d2e;border:1px solid #1e293b;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.5);" cellspacing="0" cellpadding="0" border="0">

          <!-- Header Banner -->
          <tr>
            <td style="padding:28px 32px 24px;background:linear-gradient(135deg, #09101d 0%, #152238 100%);border-bottom:2px solid #06b6d4;">
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
                <tr>
                  <td>
                    <div style="font-size:20px;font-weight:800;letter-spacing:1px;color:#ffffff;text-transform:uppercase;">
                      CAMPUS <span style="color:#06b6d4;">PRINT</span>
                    </div>
                    <div style="font-size:12px;color:#94a3b8;margin-top:4px;">Official Collection Ticket &amp; Order Confirmation</div>
                  </td>
                  <td align="right">
                    <span style="display:inline-block;padding:6px 12px;background-color:rgba(16,185,129,0.15);border:1px solid #10b981;border-radius:20px;color:#10b981;font-size:11px;font-weight:700;letter-spacing:0.5px;">
                      PAID
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Ticket Box -->
          <tr>
            <td style="padding:32px 32px 24px;">
              <p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#f1f5f9;">
                Hello <strong>${displayName}</strong>,
              </p>
              <p style="margin:0 0 24px;font-size:14px;line-height:22px;color:#94a3b8;">
                Your payment was verified successfully and your print order has been confirmed. Below is your official collection ticket.
              </p>

              <!-- Ticket Card -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#0b111e;border:1px dashed #06b6d4;border-radius:10px;padding:20px;margin-bottom:24px;">
                <tr>
                  <td align="center">
                    <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#06b6d4;text-transform:uppercase;margin-bottom:6px;">
                      TICKET NUMBER
                    </div>
                    <div style="font-size:30px;font-weight:800;letter-spacing:2px;color:#38bdf8;margin-bottom:4px;">
                      ${safeTicketNumber}
                    </div>
                    <div style="font-size:12px;color:#64748b;">
                      Order Reference: #${safeOrderId}
                    </div>
                  </td>
                </tr>
              </table>

              <!-- Order & Collection Details Table -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin-bottom:24px;">
                <tr style="border-bottom:1px solid #1e293b;">
                  <td style="padding:10px 0;font-size:13px;color:#94a3b8;">Collection Location:</td>
                  <td align="right" style="padding:10px 0;font-size:13px;font-weight:600;color:#f1f5f9;">${collectionLocation}</td>
                </tr>
                <tr style="border-bottom:1px solid #1e293b;">
                  <td style="padding:10px 0;font-size:13px;color:#94a3b8;">Collection Time Slot:</td>
                  <td align="right" style="padding:10px 0;font-size:13px;font-weight:600;color:#f1f5f9;">${collectionTime}</td>
                </tr>
                <tr style="border-bottom:1px solid #1e293b;">
                  <td style="padding:10px 0;font-size:13px;color:#94a3b8;">Collection Date:</td>
                  <td align="right" style="padding:10px 0;font-size:13px;font-weight:600;color:#f1f5f9;">${collectionDate}</td>
                </tr>
                <tr style="border-bottom:1px solid #1e293b;">
                  <td style="padding:10px 0;font-size:13px;color:#94a3b8;">Order Date:</td>
                  <td align="right" style="padding:10px 0;font-size:13px;color:#cbd5e1;">${orderDate}</td>
                </tr>
                ${maskedPhone ? `
                <tr style="border-bottom:1px solid #1e293b;">
                  <td style="padding:10px 0;font-size:13px;color:#94a3b8;">Registered Phone:</td>
                  <td align="right" style="padding:10px 0;font-size:13px;color:#cbd5e1;">${maskedPhone}</td>
                </tr>` : ''}
                ${transactionRef ? `
                <tr style="border-bottom:1px solid #1e293b;">
                  <td style="padding:10px 0;font-size:13px;color:#94a3b8;">Transaction ID:</td>
                  <td align="right" style="padding:10px 0;font-size:12px;font-family:monospace;color:#cbd5e1;">${safeTransactionRef}</td>
                </tr>` : ''}
              </table>

              <!-- Printing Details Card -->
              <div style="background-color:#162235;border-radius:8px;padding:16px;margin-bottom:28px;">
                <div style="font-size:12px;font-weight:700;color:#38bdf8;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:10px;">
                  Printing Details
                </div>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="font-size:13px;color:#cbd5e1;">
                  <tr>
                    <td style="padding:4px 0;">Documents: <strong>${fileCount} file(s)</strong></td>
                    <td align="right" style="padding:4px 0;">Total Pages: <strong>${totalPages}</strong></td>
                  </tr>
                  <tr>
                    <td style="padding:4px 0;">Format: <strong>${paperSize} • ${side}</strong></td>
                    <td align="right" style="padding:4px 0;">Total Paid: <strong style="color:#10b981;">₹${totalPrice}</strong></td>
                  </tr>
                </table>
              </div>

              <!-- Button CTA -->
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-bottom:24px;">
                <tr>
                  <td align="center">
                    <a href="${safeTicketUrl}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg, #06b6d4 0%, #0284c7 100%);color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;border-radius:8px;box-shadow:0 4px 14px rgba(6,182,212,0.35);">
                      View Ticket Online
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Attachment / Pickup Note -->
              <div style="background-color:#0b111e;border-left:4px solid #06b6d4;padding:12px 16px;border-radius:4px;font-size:12px;line-height:18px;color:#94a3b8;margin-bottom:8px;">
                📎 <strong>PDF Ticket Attached:</strong> We have attached your generated ticket as a PDF (<em>Campus-Print-Ticket-${safeTicketNumber}.pdf</em>) for offline use and printing.
              </div>
              <div style="background-color:#0b111e;border-left:4px solid #10b981;padding:12px 16px;border-radius:4px;font-size:12px;line-height:18px;color:#94a3b8;">
                ℹ️ <strong>Collection Notice:</strong> Please present your ticket number or show the ticket PDF at the pickup counter. You can also retrieve previous tickets anytime using Email Recovery on the Orders page.
              </div>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 32px;background-color:#0b111e;border-top:1px solid #1e293b;text-align:center;">
              <p style="margin:0;font-size:12px;color:#64748b;">
                Campus Print • Seamless On-Campus Printing
              </p>
              <p style="margin:6px 0 0;font-size:11px;color:#475569;">
                This is an automated confirmation sent to your registered order email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildTicketEmailText({ order, ticketNumber, ticketUrl, transactionRef }) {
    const displayName = order.guest_full_name || (order.customer_email ? order.customer_email.split('@')[0] : 'Student');
    const collectionLocation = order.collection_location || 'Campus Pickup Counter';
    const collectionTime = order.collection_time || 'Designated Slot';
    const collectionDate = formatDate(order.collection_date || order.created_at);
    const totalPrice = Number(order.total_price || 0).toFixed(2);

    return `CAMPUS PRINT — COLLECTION TICKET

Hello ${displayName},

Your payment was verified successfully and your print ticket is ready!

Ticket Number: ${ticketNumber}
Order Reference: #${order.id}
Payment Status: PAID
Total Amount: Rs. ${totalPrice}
${transactionRef ? `Transaction Ref: ${transactionRef}\n` : ''}
Collection Location: ${collectionLocation}
Collection Time: ${collectionTime}
Collection Date: ${collectionDate}

View or retrieve your ticket online:
${ticketUrl}

Your collection ticket has also been attached as a PDF to this email. Please present your ticket number or PDF at the pickup counter.

You can also retrieve your orders anytime from the Orders page.

Thank you,
Campus Print Team`;
}

/**
 * Attempts automatic ticket delivery for a verified paid order.
 * Idempotent: safe against duplicate webhooks, status polls, or browser returns.
 * Uses order_ticket_emails outbox table with row locking and unique constraints.
 *
 * @param {number} orderId - Internal orders.id
 * @param {Object} [options]
 * @param {string} [options.source='system']
 * @param {boolean} [options.force=false]
 * @returns {Promise<{ status: 'SENT'|'FAILED'|'SKIPPED'|'SENDING', messageId?: string, alreadySent?: boolean, inFlight?: boolean, error?: string }>}
 */
async function sendTicketEmail(orderId, { source = 'system', force = false } = {}) {
    const order = await Order.getOrderRecord(orderId);
    if (!order) {
        return { status: 'SKIPPED', reason: 'ORDER_NOT_FOUND' };
    }

    // Never email a ticket as paid before payment has been verified by the backend.
    if (order.payment_status !== 'PAID') {
        return { status: 'SKIPPED', reason: 'PAYMENT_NOT_PAID' };
    }
    if (order.ticket_status !== 'READY' || !order.ticket_number) {
        return { status: 'SKIPPED', reason: 'TICKET_NOT_READY' };
    }

    const recipientEmail = normalizeEmail(order.customer_email || order.guest_email);
    if (!recipientEmail) {
        return { status: 'SKIPPED', reason: 'NO_RECIPIENT_EMAIL' };
    }

    // 1. Ensure outbox record exists
    await pool.query(
        `INSERT INTO order_ticket_emails (order_id, recipient_email, status, attempts, created_at, updated_at)
         VALUES (?, ?, 'PENDING', 0, NOW(), NOW())
         ON CONFLICT (order_id) DO NOTHING`,
        [order.id, recipientEmail]
    );

    // 2. Atomically transition to SENDING
    // Allows retry if status is PENDING, FAILED, or stuck in SENDING (> 5m ago)
    const [claimRows] = await pool.query(
        `UPDATE order_ticket_emails
         SET status = 'SENDING', attempts = attempts + 1, updated_at = NOW()
         WHERE order_id = ?
           AND (
               ${force ? 'true' : "status IN ('PENDING', 'FAILED') OR (status = 'SENDING' AND updated_at < NOW() - INTERVAL '5 minutes')"}
           )
         RETURNING id, status, attempts`,
        [order.id]
    );

    if (!claimRows || claimRows.length === 0) {
        // Another thread is sending, or it is already sent
        const [existing] = await pool.query(
            `SELECT status, sent_at, provider_message_id FROM order_ticket_emails WHERE order_id = ?`,
            [order.id]
        );
        const current = existing[0];
        if (current?.status === 'SENT') {
            return { status: 'SENT', alreadySent: true, messageId: current.provider_message_id };
        }
        return { status: 'SENDING', inFlight: true };
    }

    // 3. Resolve ticket link & generate PDF attachment
    const ticketNumber = order.ticket_number;
    const ticketUrl = await resolveTicketUrl(order);

    let pdfAttachment = null;
    try {
        const pdfBuffer = await generateTicketPdf(order, { transactionRef: order.transaction_ref });
        pdfAttachment = {
            filename: `Campus-Print-Ticket-${ticketNumber}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf'
        };
    } catch (pdfErr) {
        console.error('[TICKET_PDF_GENERATION_FAILED]', {
            orderId: order.id,
            error: sanitizeDiagnostic(pdfErr.message)
        });
        // Non-fatal: email will still send with the secure web ticket link
    }

    const subject = `Your Campus Print Ticket — ${ticketNumber}`;
    const html = buildTicketEmailHtml({
        order,
        ticketNumber,
        ticketUrl,
        transactionRef: order.transaction_ref
    });
    const text = buildTicketEmailText({
        order,
        ticketNumber,
        ticketUrl,
        transactionRef: order.transaction_ref
    });

    const attachments = pdfAttachment ? [pdfAttachment] : [];

    // 4. Send email via Resend
    try {
        const result = await emailService.sendEmail({
            to: recipientEmail,
            subject,
            html,
            text,
            attachments
        });

        // Mark as SENT only after provider accepts
        await pool.query(
            `UPDATE order_ticket_emails
             SET status = 'SENT', provider = ?, provider_message_id = ?, last_error = NULL, sent_at = NOW(), updated_at = NOW()
             WHERE order_id = ?`,
            [result.provider || 'resend', result.messageId || null, order.id]
        );

        console.info('[TICKET_EMAIL_DELIVERED]', {
            orderId: order.id,
            maskedTo: maskEmail(recipientEmail),
            ticketNumber,
            provider: result.provider
        });

        return {
            status: 'SENT',
            messageId: result.messageId,
            provider: result.provider
        };
    } catch (sendError) {
        const sanitizedErr = sanitizeDiagnostic(sendError.message || 'Email delivery failed');
        await pool.query(
            `UPDATE order_ticket_emails
             SET status = 'FAILED', last_error = ?, updated_at = NOW()
             WHERE order_id = ?`,
            [sanitizedErr, order.id]
        );

        console.warn('[TICKET_EMAIL_FAILED]', {
            orderId: order.id,
            maskedTo: maskEmail(recipientEmail),
            code: sendError.code || 'EMAIL_SEND_FAILED',
            error: sanitizedErr
        });

        return {
            status: 'FAILED',
            error: sanitizedErr
        };
    }
}

/**
 * Gets delivery status for an order ticket email.
 */
async function getTicketEmailStatus(orderId) {
    const [rows] = await pool.query(
        `SELECT status, recipient_email, attempts, provider, provider_message_id, last_error, sent_at
         FROM order_ticket_emails
         WHERE order_id = ?`,
        [orderId]
    );
    const row = rows[0];
    if (!row) {
        return { status: null, recipientMasked: null, sentAt: null };
    }
    return {
        status: row.status,
        recipientMasked: row.recipient_email ? maskEmail(row.recipient_email) : null,
        attempts: row.attempts,
        provider: row.provider,
        sentAt: row.sent_at,
        lastError: sanitizeDiagnostic(row.last_error)
    };
}

/**
 * Controlled retry of failed ticket email.
 */
async function retryTicketEmail(orderId) {
    return sendTicketEmail(orderId, { source: 'manual_retry', force: true });
}

module.exports = {
    sendTicketEmail,
    getTicketEmailStatus,
    retryTicketEmail,
    resolveTicketUrl,
    buildTicketEmailHtml,
    buildTicketEmailText
};
