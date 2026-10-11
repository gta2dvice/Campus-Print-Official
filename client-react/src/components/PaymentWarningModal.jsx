import { useEffect, useRef } from 'react';
import '../styles/style.css';

// Confirmation shown right before the payment flow starts. Pure UX — it does not
// touch any payment logic; it only gates WHEN the parent's pay handler runs.
export default function PaymentWarningModal({ isOpen, processing, onCancel, onConfirm }) {
  const modalRef = useRef(null);
  const confirmBtnRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const previouslyFocused = document.activeElement;
    confirmBtnRef.current?.focus();

    function onKey(e) {
      if (e.key === 'Escape') {
        if (!processing) onCancel();
        return;
      }
      if (e.key === 'Tab') {
        const focusables = modalRef.current?.querySelectorAll('button:not([disabled])');
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    };
  }, [isOpen, processing, onCancel]);

  if (!isOpen) return null;

  return (
    <div
      className="pay-warn-overlay"
      onClick={(e) => { if (e.target === e.currentTarget && !processing) onCancel(); }}
    >
      <div className="pay-warn-modal" role="dialog" aria-modal="true" aria-labelledby="payWarnTitle" ref={modalRef}>
        <h2 id="payWarnTitle" className="pay-warn-title">
          <span aria-hidden="true">⚠️</span> Important: Payment Instructions
        </h2>

        <div className="pay-warn-body">
          <p>After completing your payment, you may be redirected back to Campus Print.</p>
          <p>
            If your ticket does not appear after the transaction,{' '}
            <span className="pay-warn-highlight">DON'T MAKE ANOTHER PAYMENT.</span>
          </p>
          <p>Go to <strong>Home → Orders</strong> to find your order history and recover your ticket.</p>
          <p>Your order can be found using the phone number used while placing the order.</p>
        </div>

        <div className="pay-warn-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={processing}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" ref={confirmBtnRef} onClick={onConfirm} disabled={processing}>
            {processing ? 'Starting…' : 'Continue to Payment'}
          </button>
        </div>
      </div>
    </div>
  );
}
