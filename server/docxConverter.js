const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const execFileAsync = util.promisify(execFile);

const DETECT_TIMEOUT_MS = 25000;

let activeRenderer = null;

function setCustomRenderer(fn) {
    activeRenderer = fn;
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Conversion timed out')), ms);
        promise.then(
            (val) => { clearTimeout(timer); resolve(val); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}

/**
 * Attempts to render DOCX (or DOC) to PDF using LibreOffice ('soffice' or configured DOCX_RENDERER_CMD).
 * Returns PDF Buffer on success, or null on failure.
 * Ensures temporary directory and files are always cleaned up.
 */
async function renderDocxToPdf(buffer, customRenderer = null) {
    const renderer = customRenderer || activeRenderer;
    if (renderer && typeof renderer === 'function') {
        return await renderer(buffer);
    }
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
    } catch (err) {
        // LibreOffice not found or conversion command failed
        return null;
    } finally {
        try {
            if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
            fs.rmdirSync(tmpDir);
        } catch {
            // ignore cleanup errors
        }
    }
    return null;
}

module.exports = {
    renderDocxToPdf,
    setCustomRenderer
};
