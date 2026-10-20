const { parentPort } = require('worker_threads');
const { PDFParse } = require('pdf-parse');
const JSZip = require('jszip');
const { resolveFileType } = require('../fileTypes');

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

async function detectPptxPages(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const slideCount = Object.keys(zip.files).filter(
        name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)
    ).length;
    if (slideCount >= 1) return { pages: slideCount, estimated: false };
    return { pages: 1, estimated: true };
}

module.exports = async ({ buffer, originalname, mimetype }) => {
    const resolved = resolveFileType(originalname, mimetype);
    const key = resolved ? resolved.key : null;
    try {
        switch (key) {
            case 'pdf':
                return await detectPdfPages(buffer);
            case 'docx':
                return await detectDocxPages(buffer);
            case 'pptx':
                return await detectPptxPages(buffer);
            case 'jpg':
            case 'png':
                return { pages: 1, estimated: false };
            default:
                return { pages: 1, estimated: true };
        }
    } catch (err) {
        console.error(`Worker page detection failed for ${originalname}:`, err.message);
        return { pages: 1, estimated: true };
    }
};
