const multer = require('multer');
const path = require('path');
const { ALLOWED_MIME_TYPES, ALLOWED_EXTENSIONS, resolveFileType } = require('../fileTypes');

// First-pass filter: accept when the extension is supported (authoritative) or
// the browser MIME is one we recognise. Magic-byte content validation happens
// after parsing (the buffer isn't available here). This blocks obvious junk
// like .exe/.zip early without trusting the browser MIME alone.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024, files: 10 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        if (resolveFileType(file.originalname, file.mimetype) || ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            if (ALLOWED_EXTENSIONS.includes(ext)) return cb(null, true);
        }
        cb(new Error('Unsupported file type'));
    }
});

module.exports = { upload, ALLOWED_MIME_TYPES, ALLOWED_EXTENSIONS };
