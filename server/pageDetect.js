const { PDFParse } = require('pdf-parse');
const JSZip = require('jszip');
const { resolveFileType } = require('./fileTypes');

// pdfjs's getDocument() promise never settles for some files (most notably
// password-protected PDFs, which wait forever on an unanswered password
// callback) — without a hard cap, one bad upload hangs the whole request.
const DETECT_TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Page detection timed out')), ms);
        promise.then(
            (val) => { clearTimeout(timer); resolve(val); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

function extractPdfPagesFromBuffer(buffer) {
    try {
        const text = buffer.toString('latin1');
        const counts = [...text.matchAll(/\/Count\s+(\d+)/gi)]
            .map(m => parseInt(m[1], 10))
            .filter(c => !isNaN(c) && c > 0);
        if (counts.length > 0) {
            return Math.max(...counts);
        }
        const pageMatches = [...text.matchAll(/\/Type\s*\/Page\b/gi)];
        if (pageMatches.length > 0) {
            return pageMatches.length;
        }
    } catch {
        // ignore
    }
    return null;
}

async function detectPdfPages(buffer) {
    try {
        const parser = new PDFParse({ data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) });
        try {
            const info = await withTimeout(parser.getInfo(), DETECT_TIMEOUT_MS);
            const total = Number(info?.total);
            if (total && total >= 1) return { pages: total, estimated: false };
        } finally {
            parser.destroy().catch(() => {});
        }
    } catch (e) {
        // Continue to binary fallback
    }

    const binaryCount = extractPdfPagesFromBuffer(buffer);
    if (binaryCount && binaryCount >= 1) {
        return { pages: binaryCount, estimated: false };
    }

    return { pages: 1, estimated: true };
}

async function detectDocxPages(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const appXmlFile = zip.file('docProps/app.xml');
    if (!appXmlFile) return { pages: 1, estimated: true };
    const xml = await appXmlFile.async('string');
    const match = /<Pages>(\d+)<\/Pages>/i.exec(xml);
    if (!match) return { pages: 1, estimated: true };
    const pages = parseInt(match[1], 10);
    if (!pages || pages < 1) return { pages: 1, estimated: true };
    return { pages, estimated: false };
}

// PPTX slide count is reliable and dependency-free: each slide is one
// ppt/slides/slideN.xml entry in the OOXML zip. One slide = one printable page.
async function detectPptxPages(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const slideCount = Object.keys(zip.files).filter(
        name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)
    ).length;
    if (slideCount >= 1) return { pages: slideCount, estimated: false };
    return { pages: 1, estimated: true };
}

/**
 * Detects page count for a single uploaded file (in-memory buffer + name/mime).
 * Reliable for PDF, images, DOCX (when Word wrote the page count) and PPTX
 * (slide count). For spreadsheets and legacy binary Office files there is no
 * reliable server-side count, so it returns a flagged 1-page estimate — callers
 * must treat `estimated: true` as "needs a user-supplied / shop-confirmed count",
 * never as an authoritative value, and never as 0.
 */
async function detectPages(file) {
    const resolved = resolveFileType(file.originalname, file.mimetype);
    const key = resolved ? resolved.key : null;
    try {
        switch (key) {
            case 'pdf':
                return await detectPdfPages(file.buffer);
            case 'docx':
                return await detectDocxPages(file.buffer);
            case 'pptx':
                return await detectPptxPages(file.buffer);
            case 'jpg':
            case 'png':
                return { pages: 1, estimated: false };
            // xls, xlsx, legacy .doc/.ppt, and unknowns: no reliable count.
            default:
                return { pages: 1, estimated: true };
        }
    } catch (err) {
        console.error(`Page detection failed for ${file.originalname}:`, err.message);
        return { pages: 1, estimated: true };
    }
}

module.exports = { detectPages };
