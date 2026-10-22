const Piscina = require('piscina');
const path = require('path');

const pool = new Piscina({
    filename: path.resolve(__dirname, 'workers/pageDetect.worker.js'),
    timeout: 20000, // 20s pool-level timeout
});

async function detectPages(file) {
    try {
        return await pool.run({
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype
        });
    } catch (err) {
        console.error(`Piscina pool error for ${file.originalname}:`, err.message);
        return { pages: null, estimated: true, requiresConfirmation: true };
    }
}

module.exports = { detectPages };
