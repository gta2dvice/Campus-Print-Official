const pool = require('../db');

async function createFiles(orderId, files) {
    if (!files || files.length === 0) return [];
    const ids = [];
    await pool.transaction(async tx => {
        for (const f of files) {
            const [result] = await tx.execute(
                `INSERT INTO order_files (order_id, original_name, stored_name, storage_path, mime_type, size_bytes, printing_side, copies, color_mode)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 RETURNING id`,
                [
                    orderId,
                    f.originalname,
                    f.storedName || f.filename,
                    f.storagePath || null,
                    f.mimetype,
                    f.size || 0,
                    f.printingSide || 'single',
                    f.copies || 1,
                    f.colorMode || 'bw'
                ]
            );
            ids.push(result.insertId);
        }
    });
    return ids;
}

async function getFilesByOrder(orderId) {
    const [rows] = await pool.execute(
        `SELECT id, order_id, original_name, mime_type, size_bytes, created_at, file_deleted_at
         FROM order_files WHERE order_id = ?`,
        [orderId]
    );
    return rows;
}

async function getFileById(fileId) {
    const [rows] = await pool.execute('SELECT * FROM order_files WHERE id = ?', [fileId]);
    return rows[0] || null;
}

module.exports = { createFiles, getFilesByOrder, getFileById };
