const { downloadFile } = require('./storage');
const { PDFDocument } = require('pdf-lib');

// Content-Disposition with the real filename: a plain ASCII fallback plus the
// RFC 5987 UTF-8 form, so "my notes.pdf" downloads as "my notes.pdf" (not my%20notes.pdf).
function contentDisposition(disposition, originalName) {
    const name = String(originalName || 'file');
    const asciiFallback = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
    return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function isMissingObjectError(error) {
    const status = Number(error?.statusCode || error?.status || error?.originalError?.status);
    return status === 404 || status === 400 || /not.?found|does not exist/i.test(String(error?.message || ''));
}

/**
 * Returns a new buffer containing only the pages of `range` ("start-end"), or null
 * when the range is absent, malformed, covers the whole document, or cannot be
 * applied — callers then send the original bytes unchanged.
 */
async function slicePdfPages(buffer, range) {
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(String(range || '').trim());
    if (!match) return null;
    const start = parseInt(match[1], 10);
    const end = match[2] !== undefined ? parseInt(match[2], 10) : start;
    if (start < 1 || end < start) return null;

    const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const total = source.getPageCount();
    if (end > total || (start === 1 && end === total)) return null;

    const output = await PDFDocument.create();
    const indices = Array.from({ length: end - start + 1 }, (_, i) => start - 1 + i);
    const pages = await output.copyPages(source, indices);
    pages.forEach((page) => output.addPage(page));
    return Buffer.from(await output.save());
}

/**
 * Streams one stored order file to an already-authorized caller (the route checks
 * access). The bucket stays private; bytes are fetched server-side with the
 * service key. Missing / deleted files get a clear JSON error the UI can show.
 *
 * When the file carries a selected page range (order_files.page_range), PDFs are
 * sliced server-side so the print workflow only ever receives those pages — the
 * printer can never accidentally print the full document.
 */
async function sendStoredFile(res, file, { download = false } = {}) {
    if (!file) return res.status(404).json({ message: 'File not found.', code: 'FILE_NOT_FOUND' });
    if (file.file_deleted_at || !file.storage_path) {
        return res.status(410).json({
            message: 'This file was deleted from storage and is no longer available.',
            code: 'FILE_DELETED'
        });
    }

    let buffer;
    try {
        buffer = await downloadFile(file.storage_path);
    } catch (error) {
        if (isMissingObjectError(error)) {
            return res.status(404).json({
                message: 'This file is missing from storage. Ask the student to upload it again.',
                code: 'FILE_MISSING'
            });
        }
        throw error;
    }

    let appliedRange = null;
    if (file.page_range && (file.mime_type === 'application/pdf' || /\.pdf$/i.test(file.original_name || ''))) {
        try {
            const sliced = await slicePdfPages(buffer, file.page_range);
            if (sliced) {
                buffer = sliced;
                appliedRange = String(file.page_range);
            }
        } catch (error) {
            // Never fail the download outright — log loudly so the slice can be fixed.
            console.error('[PAGE_RANGE_SLICE_FAILED]', {
                fileId: file.id,
                pageRange: file.page_range,
                message: error.message
            });
        }
    }

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', contentDisposition(download ? 'attachment' : 'inline', file.original_name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    if (appliedRange) res.setHeader('X-Page-Range', appliedRange);
    return res.send(buffer);
}

module.exports = { sendStoredFile, contentDisposition, slicePdfPages };
