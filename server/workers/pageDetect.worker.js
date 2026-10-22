const { parentPort } = require('worker_threads');
const { PDFParse } = require('pdf-parse');
const JSZip = require('jszip');
const { resolveFileType } = require('../fileTypes');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const execFileAsync = util.promisify(execFile);

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

/**
 * Attempts to render DOCX to PDF using an available rendering engine (e.g. LibreOffice or configured tool).
 * Returns PDF buffer if successful, or null if rendering is unavailable or fails.
 */
async function renderDocxToPdf(buffer) {
    const cmd = process.env.DOCX_RENDERER_CMD || 'soffice';
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-render-'));
    const inputPath = path.join(tmpDir, 'input.docx');
    const outputPath = path.join(tmpDir, 'input.pdf');

    try {
        fs.writeFileSync(inputPath, buffer);
        await withTimeout(
            execFileAsync(cmd, ['--headless', '--convert-to', 'pdf', '--outdir', tmpDir, inputPath]),
            DETECT_TIMEOUT_MS
        );
        if (fs.existsSync(outputPath)) {
            return fs.readFileSync(outputPath);
        }
    } catch {
        // Converter command not found in environment or conversion failed
    } finally {
        try {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            fs.rmdirSync(tmpDir);
        } catch {}
    }
    return null;
}

/**
 * Detects pages for DOCX files.
 * Uses exact PDF rendering if a rendering engine is available in the deployment environment.
 * If exact rendering is unavailable, does NOT guess by counting paragraphs or silently fall back to 1.
 * Instead, returns pages: null with estimated: true and requiresConfirmation: true.
 */
async function detectDocxPages(buffer) {
    try {
        const renderedPdf = await renderDocxToPdf(buffer);
        if (renderedPdf) {
            const pdfResult = await detectPdfPages(renderedPdf);
            if (pdfResult && typeof pdfResult.pages === 'number' && pdfResult.pages >= 1 && !pdfResult.estimated) {
                return { pages: pdfResult.pages, estimated: false };
            }
        }
    } catch {
        // Rendering failed
    }

    // Exact rendering unavailable — prevent incorrect checkout pricing and request confirmation
    return { pages: null, estimated: true, requiresConfirmation: true };
}

async function detectPptxPages(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const slideCount = Object.keys(zip.files).filter(
        name => /^ppt\/slides\/slide\d+\.xml$/i.test(name)
    ).length;
    if (slideCount >= 1) return { pages: slideCount, estimated: false };
    return { pages: 1, estimated: true };
}

const workerFunction = async ({ buffer, originalname, mimetype }) => {
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

workerFunction.detectDocxPages = detectDocxPages;
workerFunction.detectPdfPages = detectPdfPages;
workerFunction.renderDocxToPdf = renderDocxToPdf;

module.exports = workerFunction;
