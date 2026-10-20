const db = require('../db');

async function requireShopAdmin(req, res, next) {
    if (req.session && req.session.adminId && req.session.adminRole === 'shop_admin') {
        // Verify session is registered and not revoked
        try {
            const [sessions] = await db.query(
                'SELECT 1 FROM admin_sessions WHERE sid = ? AND revocation_status = false',
                [req.sessionID]
            );
            if (!sessions.length) {
                return res.status(401).json({ message: 'Session revoked or invalid' });
            }
            req.shopId = req.session.adminShopId;
            return next();
        } catch (err) {
            console.error('ShopAdmin session verification error:', err);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
    res.status(401).json({ message: 'Not authenticated' });
}

async function requireSuperAdmin(req, res, next) {
    if (req.session && req.session.superAdminId && req.session.superAdminRole === 'super_admin') {
        // Verify session is registered and not revoked
        try {
            const [sessions] = await db.query(
                'SELECT 1 FROM admin_sessions WHERE sid = ? AND revocation_status = false',
                [req.sessionID]
            );
            if (!sessions.length) {
                return res.status(401).json({ message: 'Session revoked or invalid' });
            }
            return next();
        } catch (err) {
            console.error('SuperAdmin session verification error:', err);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }
    res.status(401).json({ message: 'Not authenticated' });
}

module.exports = { requireShopAdmin, requireSuperAdmin };
