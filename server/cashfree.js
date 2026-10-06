const { Cashfree, CFEnvironment } = require('cashfree-pg');

let cashfreeClient;

function isConfigured() {
    return Boolean(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY);
}

function getMode() {
    const envSetting = (process.env.CASHFREE_ENV || '').toLowerCase();
    if (envSetting === 'production') return 'production';
    if (envSetting === 'sandbox') return 'sandbox';
    const secret = process.env.CASHFREE_SECRET_KEY || '';
    const appId = process.env.CASHFREE_APP_ID || '';
    if (secret.includes('_prod_') || appId.includes('_prod_')) {
        return 'production';
    }
    return 'sandbox';
}

function getClient() {
    if (!isConfigured()) {
        throw new Error('Cashfree is not configured');
    }
    if (cashfreeClient) return cashfreeClient;

    const env = getMode() === 'production' ? CFEnvironment.PRODUCTION : CFEnvironment.SANDBOX;
    cashfreeClient = new Cashfree(
        env,
        process.env.CASHFREE_APP_ID,
        process.env.CASHFREE_SECRET_KEY,
        undefined,
        undefined,
        undefined,
        false
    );
    return cashfreeClient;
}

function normalizePhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) return digits.slice(2);
    if (digits.length === 10) return digits;
    const fallback = String(process.env.CASHFREE_DEFAULT_PHONE || '9999999999').replace(/\D/g, '');
    return fallback.slice(-10) || '9999999999';
}

async function createPaymentSession({ orderId, amount, customerId, customerEmail, customerPhone, returnUrl, notifyUrl }) {
    const cashfree = getClient();
    const orderMeta = {};
    if (returnUrl) orderMeta.return_url = returnUrl;
    if (notifyUrl) orderMeta.notify_url = notifyUrl;

    const request = {
        order_id: orderId,
        order_amount: Number(Number(amount).toFixed(2)),
        order_currency: 'INR',
        customer_details: {
            customer_id: String(customerId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 50) || `user_${Date.now()}`,
            customer_email: customerEmail || undefined,
            customer_phone: normalizePhone(customerPhone)
        }
    };
    if (Object.keys(orderMeta).length) request.order_meta = orderMeta;

    const response = await cashfree.PGCreateOrder(request);
    const data = response.data || {};
    return {
        cashfreeOrderId: data.order_id || orderId,
        paymentSessionId: data.payment_session_id || data.payment_sessions_id,
        orderStatus: data.order_status,
        orderAmount: data.order_amount
    };
}

async function fetchOrder(cashfreeOrderId) {
    const cashfree = getClient();
    const response = await cashfree.PGFetchOrder(cashfreeOrderId);
    return response.data || {};
}

async function fetchOrderUntilPaid(cashfreeOrderId, attempts = 5, delayMs = 1000) {
    let order = {};
    for (let i = 0; i < attempts; i++) {
        order = await fetchOrder(cashfreeOrderId);
        if (isOrderPaid(order)) return order;
        if (i < attempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    return order;
}

function isOrderPaid(order) {
    const status = String(order.order_status || '').toUpperCase();
    return status === 'PAID';
}

function amountsMatch(a, b) {
    return Math.abs(Number(a) - Number(b)) < 0.05;
}

function verifyWebhookSignature(signature, rawBody, timestamp) {
    const cashfree = getClient();
    return cashfree.PGVerifyWebhookSignature(signature, rawBody, timestamp);
}

module.exports = {
    isConfigured,
    getMode,
    createPaymentSession,
    fetchOrder,
    fetchOrderUntilPaid,
    isOrderPaid,
    amountsMatch,
    verifyWebhookSignature
};
