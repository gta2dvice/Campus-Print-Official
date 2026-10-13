const { downloadFile } = require('./storage');

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
 * Streams one stored order file to an already-authorized caller (the route checks
 * access). The bucket stays private; bytes are fetched server-side with the
 * service key. Missing / deleted files get a clear JSON error the UI can show.
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

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Content-Disposition', contentDisposition(download ? 'attachment' : 'inline', file.original_name));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(buffer);
}

module.exports = { sendStoredFile, contentDisposition };
