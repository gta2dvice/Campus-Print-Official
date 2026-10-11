const { Cashfree, CFEnvironment } = require('cashfree-pg');

let cashfreeClient;

function isConfigured() {
    return Boolean(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY);
}

function getMode() {
    const envSetting = (process.env.CASHFREE_ENV || '').toLowerCase();
    if (envSetting === 'production') return 'production';
    if (envSetting === 'sandbox') return 'sandbox';
    throw new Error('CASHFREE_ENV must be set to either "sandbox" or "production".');
}

function getCreateOrderEndpoint() {
    return `${getMode() === 'production' ? 'https://api.cashfree.com' : 'https://sandbox.cashfree.com'}/pg/orders`;
}

function sanitizeDiagnostic(value) {
    let message = String(value || 'Unknown Cashfree error');
    for (const secret of [process.env.CASHFREE_APP_ID, process.env.CASHFREE_SECRET_KEY].filter(Boolean)) {
        message = message.split(secret).join('[redacted]');
    }
    return message.replace(/cfsk_[a-zA-Z0-9_-]+/g, '[redacted]');
}

function getErrorDetails(error) {
    const providerError = error.response?.data || {};
    return {
        status: error.response?.status || null,
        code: sanitizeDiagnostic(providerError.code || providerError.error_code || error.code || 'CASHFREE_ORDER_CREATE_FAILED'),
        message: sanitizeDiagnostic(providerError.message || providerError.error_description || error.message)
    };
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

    const endpoint = getCreateOrderEndpoint();
    console.info('[Cashfree] Creating order:', {
        endpoint,
        environment: getMode(),
        apiVersion: cashfree.XApiVersion,
        appIdPresent: Boolean(process.env.CASHFREE_APP_ID),
        secretPresent: Boolean(process.env.CASHFREE_SECRET_KEY),
        secretEnvironmentMismatch: getMode() === 'sandbox' && (process.env.CASHFREE_SECRET_KEY || '').includes('_prod_'),
        amount: request.order_amount,
        currency: request.order_currency,
        customerIdPresent: Boolean(request.customer_details.customer_id),
        customerPhonePresent: Boolean(request.customer_details.customer_phone),
        customerEmailPresent: Boolean(request.customer_details.customer_email)
    });

    let response;
    try {
        response = await cashfree.PGCreateOrder(request);
    } catch (error) {
        const details = getErrorDetails(error);
        console.error('[Cashfree] Create Order failed:', {
            endpoint,
            environment: getMode(),
            status: details.status,
            code: details.code,
            message: details.message
        });
        throw error;
    }

    const data = response.data || {};
    console.info('[Cashfree] Create Order response:', {
        endpoint,
        environment: getMode(),
        status: response.status,
        orderCreated: Boolean(data.order_id),
        paymentSessionReturned: Boolean(data.payment_session_id)
    });
    return {
        cashfreeOrderId: data.order_id,
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

async function fetchOrderPayments(cashfreeOrderId) {
    const cashfree = getClient();
    const response = await cashfree.PGOrderFetchPayments(cashfreeOrderId);
    return Array.isArray(response.data) ? response.data : [];
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

function isPaymentPaid(payment) {
    return String(payment.payment_status || '').toUpperCase() === 'SUCCESS';
}

function arePaymentsFinalizedAsFailed(payments) {
    return payments.length > 0 && payments.every(payment =>
        ['FAILED', 'USER_DROPPED', 'CANCELLED', 'VOID'].includes(String(payment.payment_status || '').toUpperCase())
    );
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
    getCreateOrderEndpoint,
    getErrorDetails,
    createPaymentSession,
    fetchOrder,
    fetchOrderPayments,
    fetchOrderUntilPaid,
    isOrderPaid,
    isPaymentPaid,
    arePaymentsFinalizedAsFailed,
    amountsMatch,
    verifyWebhookSignature
};
