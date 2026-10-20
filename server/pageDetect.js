const Piscina = require('piscina');
const path = require('path');

const pool = new Piscina({
    filename: path.resolve(__dirname, 'workers/pageDetect.worker.js'),
    timeout: 20000, // 20s pool-level timeout
});

async function detectPages(file) {
    try {
        // Use transferList to pass the buffer without cloning
        // file.buffer is the ArrayBuffer provided by multer
        return await pool.run({
            buffer: file.buffer,
            originalname: file.originalname,
            mimetype: file.mimetype
        }, {
            transferList: file.buffer ? [file.buffer] : []
        });
    } catch (err) {
        console.error(`Piscina pool error for ${file.originalname}:`, err.message);
        return { pages: 1, estimated: true };
    }
}

module.exports = { detectPages };
