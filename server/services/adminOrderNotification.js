const { sendEmail } = require('./emailService');
const { downloadFile } = require('../storage');
const { generateTicketPdf } = require('./ticketPdfGenerator');
const OrderFile = require('../models/OrderFile');
const Order = require('../models/Order');
const pool = require('../db');

/**
 * Sends a comprehensive payment-success notification to the admin.
 * Attachments include all uploaded documents and the generated ticket PDF.
 *
 * This function is idempotent: it tracks delivery in `admin_payment_notifications`.
 */
async function notifyAdminOfPaidOrder(orderId) {
    try {
        // 1. Idempotency Check: Ensure we only send one admin email per order
        const [notifRows] = await pool.execute(
            'SELECT id FROM admin_payment_notifications WHERE order_id = ?',
            [orderId]
        );
        if (notifRows.length > 0) {
            // Already notified admin for this order
            return { status: 'ALREADY_SENT' };
        }

        // 2. Final Verification: Must be PAID and READY
        const order = await Order.getOrderRecord(orderId);
        if (!order || order.payment_status !== 'PAID' || order.ticket_status !== 'READY' || !order.ticket_number) {
            console.log(`[ADMIN_NOTIFY_SKIP] Order ${orderId} not eligible for admin notification (Payment: ${order?.payment_status}, Ticket: ${order?.ticket_status})`);
            return { status: 'NOT_ELIGIBLE' };
        }

        const adminEmail = process.env.ORDER_NOTIFICATION_EMAIL || 'pseudointellect20@gmail.com';
        const files = await OrderFile.getFilesByOrder(orderId);

        // 3. Prepare Attachments
        const attachments = [];
        const fallbackLinks = [];
        let totalAttachmentSize = 0;
        const RESEND_ATTACHMENT_LIMIT = 10 * 1024 * 1024; // 10MB safety limit

        // A. Attach Uploaded Documents
        for (const f of files) {
            try {
                if (!f.storage_path) throw new Error('No storage path available');
                const buffer = await downloadFile(f.storage_path);
                const size = buffer.length;

                if (totalAttachmentSize + size > RESEND_ATTACHMENT_LIMIT) {
                    fallbackLinks.push({
                        name: f.original_name,
                        link: `Secure link for ${f.original_name} will be available in Admin Panel.`
                    });
                } else {
                    attachments.push({
                        filename: f.original_name,
                        content: buffer,
                        contentType: f.mime_type || 'application/octet-stream'
                    });
                    totalAttachmentSize += size;
                }
            } catch (err) {
                console.error(`[ADMIN_NOTIFY_FILE_ERROR] Order ${orderId} | File ${f.original_name}:`, err.message);
                // We do not fail the whole email if one file is missing, but we log it.
            }
        }

        // B. Attach Ticket PDF
        try {
            const ticketPdf = await generateTicketPdf(order);
            if (totalAttachmentSize + ticketPdf.length <= RESEND_ATTACHMENT_LIMIT) {
                attachments.push({
                    filename: `Ticket_${order.ticket_number}.pdf`,
                    content: ticketPdf,
                    contentType: 'application/pdf'
                });
                totalAttachmentSize += ticketPdf.length;
            } else {
                fallbackLinks.push({ name: 'Collection Ticket', link: 'Ticket size exceeds attachment limit.' });
            }
        } catch (err) {
            console.error(`[ADMIN_NOTIFY_TICKET_ERROR] Order ${orderId}:`, err.message);
        }

        // 4. Build Email Body
        const date = new Date(order.created_at).toLocaleString('en-IN', {
            dateStyle: 'full',
            timeStyle: 'short'
        });

        const fileDetails = files.map(f => `
            <li>
                <strong>${f.original_name}</strong>: ${f.page_count} pages, ${f.copies} copy/ies,
                ${f.color_mode.toUpperCase()}, ${f.printing_side},
                ${f.spiral_binding ? `Binding: ${f.binding_description || 'Yes'}` : 'No Binding'}
            </li>`).join('');

        const html = `
            <div style="font-family: sans-serif; color: #333; line-height: 1.6;">
                <h2 style="color: #0f172a;">Payment Verified: Order #${order.id}</h2>
                <p><strong>Created:</strong> ${date}</p>

                <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 15px; border-radius: 8px; margin-bottom: 20px;">
                    <strong style="color: #166534;">Payment Status: PAID</strong> |
                    <strong style="color: #166534;">Ticket: READY (#${order.ticket_number})</strong>
                </div>

                <hr/>
                <h3>Customer Details</h3>
                <ul>
                    <li><strong>Name:</strong> ${order.guest_full_name}</li>
                    <li><strong>Phone:</strong> ${order.guest_phone}</li>
                    <li><strong>Email:</strong> ${order.guest_email}</li>
                </ul>

                <hr/>
                <h3>Collection Details</h3>
                <ul>
                    <li><strong>Date:</strong> ${order.collection_date}</li>
                    <li><strong>Time Slot:</strong> ${order.collection_time}</li>
                    <li><strong>Location:</strong> ${order.collection_location}</li>
                    <li><strong>Delivery:</strong> ${order.classroom_charge > 0 ? 'Classroom' : 'Standard'}
                       ${order.guest_classroom ? `(Room: ${order.guest_classroom})` : ''}
                    </li>
                </ul>

                <hr/>
                <h3>Documents to Print</h3>
                <ul>${fileDetails}</ul>

                <hr/>
                <h3>Pricing & Payment</h3>
                <ul>
                    <li><strong>Printing Subtotal:</strong> ₹${order.printing_amount}</li>
                    <li><strong>Service Charge:</strong> ₹${order.service_charge}</li>
                    <li><strong>Binding Charge:</strong> ₹${order.binding_charge || 0}</li>
                    <li><strong>Delivery Charge:</strong> ₹${order.delivery_charge || 0}</li>
                    <li><strong>Total Amount:</strong> ₹${order.total_price}</li>
                    <li><strong>Payment Method:</strong> ${order.payment_method}</li>
                    <li><strong>Transaction Ref:</strong> ${order.transaction_ref || 'N/A'}</li>
                </ul>
                ${fallbackLinks.length > 0 ? `
                <div style="background: #fff3cd; padding: 10px; border: 1px solid #ffeeba; margin-top: 20px; border-radius: 8px;">
                    <strong style="color: #856404;">Note:</strong> Some files were too large to attach to this email.
                    They are available for download in the Admin Panel.
                    <ul>${fallbackLinks.map(l => `<li>${l.name}</li>`).join('')}</ul>
                </div>` : ''}
            </div>
        `;

        // 5. Send Email
        await sendEmail({
            to: adminEmail,
            subject: `Payment Success: Order #${order.id} - ${order.guest_full_name}`,
            html,
            attachments
        });

        // 6. Mark as Sent to prevent duplicates
        await pool.execute(
            'INSERT INTO admin_payment_notifications (order_id, status) VALUES (?, ?)',
            [orderId, 'SENT']
        );

        return { status: 'SENT' };

    } catch (err) {
        console.error(`[ADMIN_NOTIFY_ERROR] Order ${orderId}:`, err.message);
        // Log failure to DB if we attempted to send
        try {
            await pool.execute(
                'INSERT INTO admin_payment_notifications (order_id, status, last_error) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE last_error = ?',
                [orderId, 'FAILED', err.message, err.message]
            );
        } catch (dbErr) {
            console.error('[ADMIN_NOTIFY_DB_ERROR]', dbErr.message);
        }
        return { status: 'FAILED', error: err.message };
    }
}

module.exports = { notifyAdminOfPaidOrder };
