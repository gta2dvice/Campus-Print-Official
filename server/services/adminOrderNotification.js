const { sendEmail } = require('./emailService');
const { downloadFile } = require('../storage');
const OrderFile = require('../models/OrderFile');
const Order = require('../models/Order');

/**
Casts the order into a detailed HTML notification for the admin.
Includes pricing, customer details, and attaches uploaded files.
*/
async function notifyAdminOfNewOrder(orderId) {
    try {
        const order = await Order.getOrderRecord(orderId);
        if (!order) {
            console.error(`[ADMIN_NOTIFY_ERROR] Order not found: ${orderId}`);
            return;
        }

        const adminEmail = process.env.ORDER_NOTIFICATION_EMAIL || 'pseudointellect20@gmail.com';
        const files = await OrderFile.getFilesByOrder(orderId);

        // Prepare attachments
        const attachments = [];
        const fallbackLinks = [];
        let totalAttachmentSize = 0;
        const RESEND_ATTACHMENT_LIMIT = 10 * 1024 * 1024; // 10MB limit for safety

        for (const f of files) {
            try {
                const buffer = await downloadFile(f.storage_path);
                const size = buffer.length;

                if (totalAttachmentSize + size > RESEND_ATTACHMENT_LIMIT) {
                    fallbackLinks.push({
                        name: f.original_name,
                        // In a real scenario, this would be a signed URL from Supabase.
                        // For now, we acknowledge the limit and list the file.
                        link: `File ${f.original_name} exceeds attachment limit.`
                    });
                } else {
                    attachments.push({
                        filename: f.original_name,
                        content: buffer,
                        contentType: f.mime_type
                    });
                    totalAttachmentSize += size;
                }
            } catch (err) {
                console.error(`[ADMIN_NOTIFY_FILE_ERROR] Could not attach ${f.original_name}:`, err.message);
            }
        }

        // Build Order Details HTML
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
                <h2>New Order Received (#${order.id})</h2>
                <p><strong>Created:</strong> ${date}</p>

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
                <h3>Files</h3>
                <ul>${fileDetails}</ul>

                <hr/>
                <h3>Pricing & Payment</h3>
                <ul>
                    <li><strong>Printing Subtotal:</strong> ₹${order.printing_amount}</li>
                    <li><strong>Service Charge:</strong> ₹${order.service_charge}</li>
                    <li><strong>Binding Charge:</strong> ₹${order.binding_charge || 0}</li>
                    <li><strong>Delivery Charge:</strong> ₹${order.delivery_charge || 0}</li>
                    <li><strong>Total:</strong> ₹${order.total_price}</li>
                    <li><strong>Payment Method:</strong> ${order.payment_method}</li>
                    <li><strong>Payment Status:</strong> ${order.payment_status}</li>
                </ul>
                ${fallbackLinks.length > 0 ? `
                <div style="background: #fff3cd; padding: 10px; border: 1px solid #ffeeba; margin-top: 20px;">
                    <strong>Note:</strong> Some files were too large to attach. Please download them from the admin panel.
                    <ul>${fallbackLinks.map(l => `<li>${l.name}</li>`).join('')}</ul>
                </div>` : ''}
            </div>
        `;

        await sendEmail({
            to: adminEmail,
            subject: `New Order #${order.id} - ${order.guest_full_name}`,
            html,
            attachments
        });

    } catch (err) {
        console.error(`[ADMIN_NOTIFY_ERROR] Order ${orderId}:`, err.message);
    }
}

module.exports = { notifyAdminOfNewOrder };
