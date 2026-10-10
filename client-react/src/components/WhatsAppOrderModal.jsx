import { useEffect, useRef } from 'react';
import '../styles/style.css';

// Exact copy from the spec — fixed UX strings (not deployment config).
export const WA_ORDER_TEMPLATE = `Hi Campus Print, I want to place a printing order.

Name:
Phone:
Number of files:

Printing:
Single-sided / Double-sided

Color:
Black & White / Color

Copies:

Collection Location:
Collection Date/Time:

Payment completed: Yes

I will send my files and payment screenshot in this chat.`;

export const WA_ACK_MESSAGE = 'Payment completed. Please acknowledge and confirm my order.';

// Manual-order instruction modal for the Personal WhatsApp flow.
// Pure UX: it never creates an order/ticket and never touches Cashfree.
export default function WhatsAppOrderModal({
  isOpen,
  onCancel,
  onContinue,
  opening,
  whatsappNumber,
  upi,
  hasQr,
  qrVersion,
  fileInfo,
  showToast,
}) {
  const modalRef = useRef(null);
  const continueBtnRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previouslyFocused = document.activeElement;
    continueBtnRef.current?.focus();
    function onKey(e) {
      if (e.key === 'Escape') { if (!opening) onCancel(); return; }
      if (e.key === 'Tab') {
        const f = modalRef.current?.querySelectorAll('button:not([disabled])');
        if (!f || f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    };
  }, [isOpen, opening, onCancel]);

  if (!isOpen) return null;

  async function copy(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      showToast?.(`${label} copied.`, 'success');
    } catch {
      showToast?.(`Couldn't copy ${label.toLowerCase()}. Please copy it manually.`, 'error');
    }
  }

  const CopyRow = ({ label, value, copyText, copyLabel, mono }) => (
    <div className="wa-copy-row">
      <div className="wa-copy-main">
        <span className="wa-copy-label">{label}</span>
        <span className={`wa-copy-value${mono ? ' wa-mono' : ''}`}>{value}</span>
      </div>
      <button type="button" className="btn btn-outline wa-copy-btn" onClick={() => copy(copyText, copyLabel)}>
        Copy
      </button>
    </div>
  );

  return (
    <div className="wa-overlay" onClick={(e) => { if (e.target === e.currentTarget && !opening) onCancel(); }}>
      <div className="wa-modal" role="dialog" aria-modal="true" aria-labelledby="waTitle" ref={modalRef}>
        <h2 id="waTitle" className="wa-title">
          <span aria-hidden="true">💬</span> How to Order via WhatsApp
        </h2>

        {/* Prominent manual-processing notice */}
        <div className="wa-notice" role="note">
          <p>⚠️ WhatsApp orders are processed <strong>manually</strong>.</p>
          <p>🎫 <strong>No automatic ticket</strong> will be generated for WhatsApp orders.</p>
          <p>Our team manually verifies files, requirements and payment before confirmation.</p>
        </div>

        <div className="wa-body">
          {/* 1. Send files & order details */}
          <section className="wa-section">
            <h3 className="wa-section-title">1. Send Files &amp; Order Details</h3>
            <p>Send these to the WhatsApp number below:</p>
            <ul className="wa-list">
              <li>Your document files</li>
              <li>Printing: Single / Double-sided, B&amp;W / Color</li>
              <li>Copies / number of files</li>
              <li>Collection location + date/time</li>
              <li>Name, Phone, and Class/Section</li>
            </ul>
            {fileInfo && (
              <p className="wa-fineprint">
                Accepted: {fileInfo.supported} · up to {fileInfo.maxSizeMb} MB per file · max {fileInfo.maxFiles} files.
              </p>
            )}
            <CopyRow
              label="WhatsApp number (files, details & screenshot)"
              value={whatsappNumber || 'Not configured'}
              copyText={whatsappNumber || ''}
              copyLabel="WhatsApp number"
            />
          </section>

          {/* 2. Make payment */}
          <section className="wa-section">
            <h3 className="wa-section-title">2. Make Payment</h3>
            <p>Pay to the payment target below — this is <strong>only for payment</strong>, separate from the WhatsApp number.</p>
            {upi ? (
              <CopyRow
                label="Payment UPI / number (payment only)"
                value={upi}
                copyText={upi}
                copyLabel="Payment UPI"
                mono
              />
            ) : (
              <p className="wa-fineprint">No UPI configured — scan the QR below to pay.</p>
            )}
            {hasQr && (
              <div className="wa-qr-wrap">
                <img
                  className="wa-qr"
                  src={`/api/orders/payment-options/qr?v=${qrVersion || ''}`}
                  alt="Shop payment QR code"
                />
                <span className="wa-fineprint">Scan with any UPI app.</span>
              </div>
            )}
          </section>

          {/* 3. Send payment screenshot */}
          <section className="wa-section">
            <h3 className="wa-section-title">3. Send Payment Screenshot</h3>
            <p>After paying, send the <strong>successful transaction screenshot</strong> to the WhatsApp number for manual verification.</p>
            <div className="wa-alert">
              ⚠️ Payment deducted but no ticket? <strong>DON'T MAKE THE PAYMENT AGAIN.</strong> Send the transaction screenshot and contact the team for verification.
            </div>
          </section>

          {/* 4. Order confirmation */}
          <section className="wa-section">
            <h3 className="wa-section-title">4. Order Confirmation</h3>
            <p>Your order is <strong>manually verified and confirmed</strong> by our team. No automatic ticket is created for WhatsApp orders.</p>
          </section>

          {/* Security */}
          <div className="wa-security" role="note">
            🔒 Never send OTP, UPI PIN, ATM PIN, card number, CVV, banking password or other confidential banking information on WhatsApp. Only send the transaction/payment confirmation screenshot.
          </div>

          {/* Quick copy actions */}
          <section className="wa-section">
            <h3 className="wa-section-title">Quick copy</h3>
            <div className="wa-actions-grid">
              <button type="button" className="btn btn-outline" onClick={() => copy(WA_ACK_MESSAGE, 'Acknowledgement message')}>
                Copy acknowledgement message
              </button>
              <button type="button" className="btn btn-outline" onClick={() => copy(WA_ORDER_TEMPLATE, 'Order format')}>
                Copy order format
              </button>
            </div>
            <p className="wa-fineprint">You must still manually attach your files and payment screenshot in the chat — they can't be sent through the template.</p>
          </section>
        </div>

        <div className="wa-footer">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={opening}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            ref={continueBtnRef}
            onClick={onContinue}
            disabled={opening || !whatsappNumber}
          >
            {opening ? 'Opening…' : 'Continue to WhatsApp'}
          </button>
        </div>
      </div>
    </div>
  );
}
