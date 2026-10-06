const pool = require('../db');
const { deleteFiles, STORAGE_BUCKET } = require('../storage');
const { getServiceClient } = require('../supabaseClient');

const TTL_MS = process.env.CLEANUP_TTL_MS ? parseInt(process.env.CLEANUP_TTL_MS) : 24 * 60 * 60 * 1000;


async function listAllObjects(prefix = '') {
    const supabase = getServiceClient();
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET).list(prefix || '', {
        limit: 1000,
        offset: 0
    });
    if (error) throw error;
    const files = [];
    for (const item of data || []) {
        const full = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.id) {
            files.push({ path: full, createdAt: item.created_at || item.updated_at });
        } else {
            files.push(...await listAllObjects(full));
        }
    }
    return files;
}

async function cleanupExpiredPdfs() {
    const cutoff = new Date(Date.now() - TTL_MS);
    const cutoffIso = cutoff.toISOString();

    const [rows] = await pool.query(
        `SELECT id, storage_path FROM order_files
         WHERE storage_path IS NOT NULL
           AND file_deleted_at IS NULL
           AND created_at < ?`,
        [cutoffIso]
    );

    const deletedIds = [];
    const skipped = [];

    for (const row of rows) {
        const storagePath = row.storage_path;
        if (!storagePath || storagePath.includes('..')) {
            skipped.push(row.id);
            continue;
        }
        try {
            await deleteFiles([storagePath]);
            await pool.execute(
                `UPDATE order_files SET storage_path = NULL, file_deleted_at = NOW() WHERE id = ? AND file_deleted_at IS NULL`,
                [row.id]
            );
            deletedIds.push(row.id);
        } catch (err) {
            const missing = /not found|404|Object not found/i.test(err.message || '');
            if (missing) {
                await pool.execute(
                    `UPDATE order_files SET storage_path = NULL, file_deleted_at = NOW() WHERE id = ? AND file_deleted_at IS NULL`,
                    [row.id]
                );
                deletedIds.push(row.id);
            } else {
                console.error(`Cleanup failed for order_files.id=${row.id}:`, err.message);
                skipped.push(row.id);
            }
        }
    }

    let orphanDeleted = 0;
    try {
        const objects = await listAllObjects('');
        const [active] = await pool.query(
            `SELECT storage_path FROM order_files WHERE storage_path IS NOT NULL AND file_deleted_at IS NULL`
        );
        const keep = new Set(active.map(r => r.storage_path));
        // Shop payment QR images live in the same bucket but aren't order files — never treat them as orphans.
        const [qrs] = await pool.query(`SELECT payment_qr_path FROM shops WHERE payment_qr_path IS NOT NULL`);
        qrs.forEach(r => keep.add(r.payment_qr_path));
        const stale = objects.filter(obj => {
            if (!obj.path || obj.path.includes('..')) return false;
            if (keep.has(obj.path)) return false;
            const created = obj.createdAt ? new Date(obj.createdAt) : null;
            return created && created < cutoff;
        });
        if (stale.length) {
            await deleteFiles(stale.map(s => s.path));
            orphanDeleted = stale.length;
        }
    } catch (err) {
        console.error('Orphan storage scan skipped:', err.message);
    }

    return {
        bucket: STORAGE_BUCKET,
        cutoff: cutoffIso,
        examined: rows.length,
        deleted: deletedIds.length,
        skipped: skipped.length,
        orphanDeleted,
        deletedIds
    };
}

module.exports = { cleanupExpiredPdfs, TTL_MS };
