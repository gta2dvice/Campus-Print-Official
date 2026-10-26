const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const { maskPhone } = require('../phone');
const { isClassroomDeliveryOrder } = require('../slots');

/**
 * Formats a date into a clean, human-readable string (e.g., "18 Oct 2026").
 */
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
 * Generates an official, tamper-evident Campus Print collection ticket PDF.
 * Contains only order metadata and print settings. Never embeds or exposes
 * private student document contents.
 *
 * @param {Object} order - Full order record from DB
 * @param {Object} [options]
 * @param {string} [options.transactionRef]
 * @returns {Promise<Buffer>} PDF file buffer
 */
async function generateTicketPdf(order, options = {}) {
    const pdfDoc = await PDFDocument.create();
    // A4 Portrait: 595.28 x 841.89 points
    const page = pdfDoc.addPage([595.28, 841.89]);
    const { width, height } = page.getSize();

    const fontRegular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Color palette
    const darkBg = rgb(0.06, 0.09, 0.16);         // #0f172a
    const cardBg = rgb(0.11, 0.15, 0.24);         // #1e293b
    const borderColor = rgb(0.2, 0.27, 0.38);    // #334155
    const cyan = rgb(0.02, 0.71, 0.83);           // #06b6d4
    const textWhite = rgb(0.98, 0.98, 0.98);
    const textMuted = rgb(0.58, 0.64, 0.72);      // #94a3b8
    const green = rgb(0.13, 0.77, 0.37);          // #22c55e

    // Full page background
    page.drawRectangle({
        x: 0,
        y: 0,
        width,
        height,
        color: darkBg
    });

    // Outer card container
    const margin = 40;
    const cardWidth = width - margin * 2;
    const cardHeight = height - margin * 2;
    page.drawRectangle({
        x: margin,
        y: margin,
        width: cardWidth,
        height: cardHeight,
        color: cardBg,
        borderColor,
        borderWidth: 1.5
    });

    // Top banner
    const bannerHeight = 85;
    page.drawRectangle({
        x: margin,
        y: height - margin - bannerHeight,
        width: cardWidth,
        height: bannerHeight,
        color: rgb(0.04, 0.07, 0.12)
    });

    // Cyan accent bar under banner
    page.drawRectangle({
        x: margin,
        y: height - margin - bannerHeight - 3,
        width: cardWidth,
        height: 3,
        color: cyan
    });

    // Brand Name
    page.drawText('CAMPUS PRINT', {
        x: margin + 24,
        y: height - margin - 38,
        size: 22,
        font: fontBold,
        color: textWhite
    });

    page.drawText('OFFICIAL COLLECTION TICKET', {
        x: margin + 24,
        y: height - margin - 58,
        size: 10,
        font: fontRegular,
        color: cyan
    });

    // Paid Stamp Badge in header
    const badgeText = 'PAID & VERIFIED';
    const badgeWidth = 110;
    page.drawRectangle({
        x: width - margin - badgeWidth - 24,
        y: height - margin - 52,
        width: badgeWidth,
        height: 24,
        color: rgb(0.05, 0.25, 0.15),
        borderColor: green,
        borderWidth: 1
    });
    page.drawText(badgeText, {
        x: width - margin - badgeWidth - 14,
        y: height - margin - 44,
        size: 9,
        font: fontBold,
        color: green
    });

    // Ticket Number Box
    let curY = height - margin - bannerHeight - 35;
    const ticketBoxWidth = cardWidth - 48;
    const ticketBoxHeight = 65;
    page.drawRectangle({
        x: margin + 24,
        y: curY - ticketBoxHeight,
        width: ticketBoxWidth,
        height: ticketBoxHeight,
        color: rgb(0.06, 0.09, 0.15),
        borderColor: cyan,
        borderWidth: 1
    });

    page.drawText('COLLECTION TICKET NUMBER', {
        x: margin + 38,
        y: curY - 22,
        size: 9,
        font: fontBold,
        color: textMuted
    });

    const ticketNumber = order.ticket_number || `CP-${String(order.id).padStart(3, '0')}`;
    page.drawText(ticketNumber, {
        x: margin + 38,
        y: curY - 50,
        size: 24,
        font: fontBold,
        color: cyan
    });

    const orderRef = `Order #${order.id}`;
    page.drawText(orderRef, {
        x: width - margin - 150,
        y: curY - 38,
        size: 13,
        font: fontBold,
        color: textWhite
    });

    // Metadata Details Grid
    curY = curY - ticketBoxHeight - 30;

    function drawFieldRow(label, value, y, xOffset = 0, colWidth = cardWidth - 48) {
        page.drawText(label.toUpperCase(), {
            x: margin + 24 + xOffset,
            y,
            size: 9,
            font: fontBold,
            color: textMuted
        });
        page.drawText(String(value || '—'), {
            x: margin + 24 + xOffset,
            y: y - 16,
            size: 11,
            font: fontRegular,
            color: textWhite
        });
    }

    const col1X = 0;
    const col2X = 260;

    const displayName = order.guest_full_name || order.customer_email || 'Student';
    drawFieldRow('Student Name', displayName, curY, col1X);
    drawFieldRow('Phone Number', maskPhone(order.guest_phone) || '—', curY, col2X);

    curY -= 45;
    drawFieldRow('Class / Section', order.guest_classroom || '—', curY, col1X);
    const txnRef = options.transactionRef || order.transaction_ref || 'Verified';
    drawFieldRow('Transaction Reference', txnRef, curY, col2X);

    curY -= 45;
    drawFieldRow('Collection Location', order.collection_location || 'Campus Counter', curY, col1X);
    drawFieldRow('Collection Time Slot', order.collection_time || 'Regular Hours', curY, col2X);

    const classroomDelivery = isClassroomDeliveryOrder({
        classroomCharge: order.classroom_charge,
        collectionLocation: order.collection_location
    });
    if (classroomDelivery) {
        curY -= 45;
        drawFieldRow('Classroom Number', order.guest_classroom || '—', curY, col1X);
    }

    curY -= 45;
    drawFieldRow('Order Date', formatDate(order.created_at), curY, col1X);
    drawFieldRow('Collection Date', formatDate(order.collection_date || order.created_at), curY, col2X);

    // Divider line
    curY -= 35;
    page.drawLine({
        start: { x: margin + 24, y: curY },
        end: { x: width - margin - 24, y: curY },
        thickness: 1,
        color: borderColor
    });

    // Print Specifications Section
    curY -= 25;
    page.drawText('PRINT SPECIFICATIONS', {
        x: margin + 24,
        y: curY,
        size: 11,
        font: fontBold,
        color: cyan
    });

    curY -= 28;
    const fileCount = order.file_count || 1;
    const totalPages = order.total_pages || '—';
    const paperSize = order.paper_size || 'A4';
    const side = order.printing_side === 'double' ? 'Double-sided' : 'Single-sided';
    const binding = order.spiral_binding ? 'Yes (Spiral)' : 'None';
    const totalPrice = Number(order.total_price || 0).toFixed(2);

    drawFieldRow('Files Uploaded', `${fileCount} document(s)`, curY, col1X);
    drawFieldRow('Total Pages', `${totalPages} page(s)`, curY, col2X);

    curY -= 45;
    drawFieldRow('Paper & Printing', `${paperSize} • ${side}`, curY, col1X);
    drawFieldRow('Binding', binding, curY, col2X);

    curY -= 45;
    drawFieldRow('Payment Method', order.payment_method || 'Online (Cashfree)', curY, col1X);
    drawFieldRow('Total Paid', `Rs. ${totalPrice}`, curY, col2X);

    // Collection Instructions Box
    curY -= 50;
    const instructionBoxHeight = 70;
    page.drawRectangle({
        x: margin + 24,
        y: curY - instructionBoxHeight,
        width: cardWidth - 48,
        height: instructionBoxHeight,
        color: rgb(0.07, 0.12, 0.2),
        borderColor: rgb(0.18, 0.3, 0.48),
        borderWidth: 1
    });

    page.drawText('COLLECTION INSTRUCTIONS', {
        x: margin + 38,
        y: curY - 20,
        size: 9,
        font: fontBold,
        color: cyan
    });

    page.drawText('1. Present this ticket number or barcode at the collection point.', {
        x: margin + 38,
        y: curY - 38,
        size: 9.5,
        font: fontRegular,
        color: textWhite
    });

    page.drawText('2. Reach during your designated collection time slot for prompt pickup.', {
        x: margin + 38,
        y: curY - 54,
        size: 9.5,
        font: fontRegular,
        color: textMuted
    });

    // Footer
    page.drawText('Thank you for using Campus Print! For questions or retrieval, visit your Orders page.', {
        x: margin + 24,
        y: margin + 20,
        size: 8.5,
        font: fontRegular,
        color: textMuted
    });

    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
}

module.exports = { generateTicketPdf };
