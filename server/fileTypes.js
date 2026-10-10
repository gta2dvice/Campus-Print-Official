// Canonical supported upload types for Campus Print.
//
// Validation is authoritative on the SERVER and never trusts the browser MIME:
//   1. extension decides the logical type (label),
//   2. magic bytes confirm the real file family (pdf / ooxml-zip / legacy-ole /
//      jpeg / png) so a renamed .exe/.zip is rejected.
// Note: all OOXML files share the ZIP signature and all legacy Office files
// share the OLE signature, so magic bytes confirm the family, while the
// extension distinguishes docx vs xlsx vs pptx.
const path = require('path');

// family → page-count reliability is decided in pageDetect.js, not here.
const TYPES = {
    pdf:  { label: 'PDF',  exts: ['.pdf'],          family: 'pdf',  mimes: ['application/pdf'] },
    doc:  { label: 'DOC',  exts: ['.doc'],          family: 'ole',  mimes: ['application/msword'] },
    docx: { label: 'DOCX', exts: ['.docx'],         family: 'zip',  mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'] },
    ppt:  { label: 'PPT',  exts: ['.ppt'],          family: 'ole',  mimes: ['application/vnd.ms-powerpoint'] },
    pptx: { label: 'PPTX', exts: ['.pptx'],         family: 'zip',  mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] },
    xls:  { label: 'XLS',  exts: ['.xls'],          family: 'ole',  mimes: ['application/vnd.ms-excel'] },
    xlsx: { label: 'XLSX', exts: ['.xlsx'],         family: 'zip',  mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'] },
    jpg:  { label: 'JPG',  exts: ['.jpg', '.jpeg'], family: 'jpeg', mimes: ['image/jpeg', 'image/jpg'] },
    png:  { label: 'PNG',  exts: ['.png'],          family: 'png',  mimes: ['image/png'] },
};

const EXT_TO_KEY = {};
for (const [key, def] of Object.entries(TYPES)) {
    for (const ext of def.exts) EXT_TO_KEY[ext] = key;
}

const ALLOWED_MIME_TYPES = [...new Set(Object.values(TYPES).flatMap(t => t.mimes))];
const ALLOWED_EXTENSIONS = Object.keys(EXT_TO_KEY);
const SUPPORTED_LABELS = ['PDF', 'DOC', 'DOCX', 'PPT', 'PPTX', 'XLS', 'XLSX', 'JPG', 'PNG'];

// Resolve by extension (authoritative), sanity-checking the browser MIME only as
// a loose hint. Returns { key, label, family, mime } or null for unsupported.
function resolveFileType(originalName, browserMime) {
    const ext = path.extname(String(originalName || '')).toLowerCase();
    const key = EXT_TO_KEY[ext];
    if (!key) return null;
    const def = TYPES[key];
    return { key, label: def.label, family: def.family, mime: def.mimes[0], browserMime: browserMime || null };
}

function startsWithBytes(buffer, bytes) {
    if (!buffer || buffer.length < bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) {
        if (buffer[i] !== bytes[i]) return false;
    }
    return true;
}

const SIG = {
    pdf: [0x25, 0x50, 0x44, 0x46],                               // %PDF
    zip: [0x50, 0x4b],                                           // PK (ZIP / OOXML)
    ole: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],       // OLE compound (legacy Office)
    jpeg: [0xff, 0xd8, 0xff],
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

// Confirms the buffer's real family matches the resolved type.
function validateMagic(buffer, family) {
    switch (family) {
        case 'pdf': return startsWithBytes(buffer, SIG.pdf);
        case 'zip': return startsWithBytes(buffer, SIG.zip);
        case 'ole': return startsWithBytes(buffer, SIG.ole);
        case 'jpeg': return startsWithBytes(buffer, SIG.jpeg);
        case 'png': return startsWithBytes(buffer, SIG.png);
        default: return false;
    }
}

module.exports = {
    TYPES,
    ALLOWED_MIME_TYPES,
    ALLOWED_EXTENSIONS,
    SUPPORTED_LABELS,
    resolveFileType,
    validateMagic,
};
