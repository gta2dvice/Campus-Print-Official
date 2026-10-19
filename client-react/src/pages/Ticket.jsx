import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import PageBackground from '../components/PageBackground';
import Footer from '../components/Footer';
import LogoLink from '../components/LogoLink';
import useBodyClass from '../lib/useBodyClass';
import useDocumentTitle from '../lib/useDocumentTitle';
import { getDeliveryContact } from '../lib/deliveryPersons';
import '../styles/style.css';
import '../styles/dashboard.css';
import '../styles/ticket.css';

// States where the outcome isn't final yet; the page re-checks the server for these.
const STILL_OPEN_STATES = ['PAYMENT_PENDING', 'PAYMENT_PROCESSING', 'TICKET_GENERATION_PENDING'];

function stateHeader(order) {
  const keepLink = 'Keep this link — this page updates automatically once your payment is confirmed.';
  switch (order.state) {
    case 'TICKET_GENERATION_PENDING':
      return {
        title: 'Payment received',
        highlight: 'preparing your ticket',
        subtitle: 'Your payment is confirmed. Your collection ticket is being generated — you will not be charged again.',
        note: 'This page updates automatically.'
      };
    case 'PAYMENT_FAILED':
      return {
        title: 'Payment failed',
        highlight: 'no ticket yet',
        subtitle: 'This payment did not go through. Your order is saved — you can pay again for it.',
        note: 'Open the Orders page to retry payment for this order.'
      };
    case 'REFUNDED':
      return {
        title: 'Order refunded',
        highlight: 'no ticket',
        subtitle: 'The payment for this order was refunded.',
        note: 'Contact the shop if you have questions.'
      };
    case 'EXPIRED':
      return {
        title: 'Order placed',
        highlight: 'QR expired',
        subtitle: 'The payment QR expired before payment was confirmed. Your order is saved and still unpaid.',
        note: 'Open the Orders page to get a fresh QR, or contact the shop if you already paid.'
      };
    case 'PAYMENT_PROCESSING':
      return {
        title: 'Payment processing',
        highlight: 'almost there',
        subtitle: 'Your payment is being processed by Cashfree. This should only take a moment.',
        note: 'This page updates automatically.'
      };
    default: {
      const method = order.payment?.method;
      const subtitle = method === 'cashfree'
        ? 'We are confirming your payment with Cashfree.'
        : method === 'none'
          ? 'Pay at the counter when you collect your prints. The shop will confirm your payment.'
          : 'The shop will confirm your payment shortly.';
      return { title: 'Order placed', highlight: 'payment pending', subtitle, note: keepLink };
    }
  }
}

export default function Ticket() {
  useBodyClass('ticket-page-body');
  useDocumentTitle('Collection Ticket – Campus Prints');
  const [searchParams] = useSearchParams();
  const ticketToken = searchParams.get('token');
  const orderId = searchParams.get('id');
  const [order, setOrder] = useState(null);
  const [ticketError, setTicketError] = useState('');
  const [recheckKey, setRecheckKey] = useState(0);
  const [checking, setChecking] = useState(false);
  const [retryingEmail, setRetryingEmail] = useState(false);
  const [retryFeedback, setRetryFeedback] = useState('');

  useEffect(() => {
    if (!ticketToken && !orderId) {
      setTicketError('The secure ticket link is missing.');
      return;
    }
    let cancelled = false;
    let timer = null;
    async function loadTicket() {
      setChecking(true);
      try {
        const endpoint = ticketToken
          ? `/api/orders/ticket/${encodeURIComponent(ticketToken)}`
          : `/api/orders/${encodeURIComponent(orderId)}`;
        const res = await fetch(endpoint, { credentials: 'include' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.error('[TICKET_LOAD_FAILED]', {
            stage: 'ticket_lookup_response',
            httpStatus: res.status,
            code: data.code || 'TICKET_LOAD_FAILED'
          });
          if (!cancelled) setTicketError(data.message || `Ticket lookup failed (${res.status}).`);
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        setOrder(data);
        if (STILL_OPEN_STATES.includes(data.state)) timer = setTimeout(loadTicket, 10000);
      } catch (error) {
        console.error('[TICKET_LOAD_FAILED]', {
          stage: 'ticket_lookup_request',
          errorName: error instanceof Error ? error.name : 'UnknownError'
        });
        if (!cancelled) setTicketError('Could not reach the server to load this ticket. Please retry.');
      } finally {
        if (!cancelled) setChecking(false);
      }
    }
    loadTicket();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [orderId, ticketToken, recheckKey]);

  const displayName = order?.guest_full_name || order?.customer_name || (order?.customer_email ? order.customer_email.split('@')[0] : 'Guest');
  const displayPhone = order?.guest_phone || order?.customer_phone || '—';
  // Everything below comes from the server's state for this order, never from the URL.
  const isPaid = order?.state === 'TICKET_READY';
  // Assigned by the order's saved collection location (lib/deliveryPersons.js).
  const deliveryContact = order ? getDeliveryContact(order.collection_location_id, order.collection_location) : null;
  const header = order ? stateHeader(order) : null;

  async function handleRetryEmail() {
    setRetryingEmail(true);
    setRetryFeedback('');
    try {
      const endpoint = ticketToken
        ? `/api/orders/ticket/${encodeURIComponent(ticketToken)}/retry-email`
        : `/api/orders/${encodeURIComponent(orderId)}/retry-email`;
      const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setOrder(prev => ({ ...prev, emailDelivery: data.emailDelivery }));
        setRetryFeedback('Email sent successfully!');
      } else {
        setRetryFeedback(data.message || 'Email delivery failed. Please retry later.');
      }
    } catch {
      setRetryFeedback('Could not connect to server to retry email.');
    } finally {
      setRetryingEmail(false);
    }
  }

  return (
    <>
      <PageBackground />
      <LogoLink />

      <div className="ticket-page-wrapper">
        <div className="booking-orb booking-orb-1"></div>
        <div className="booking-orb booking-orb-2"></div>

        <main className="ticket-main-content">
          {ticketError ? (
            <section className="ticket-success-header">
              <h1 className="success-heading">Ticket unavailable</h1>
              <p className="success-subtitle">{ticketError}</p>
              <Link to="/" className="ticket-btn ticket-btn-primary">Back to home</Link>
            </section>
          ) : !order ? (
            <section className="ticket-success-header">
              <h1 className="success-heading">Loading your ticket…</h1>
            </section>
          ) : (
            <>

          {/* Captured by "Download Ticket" (window.print) — scoped to the success
              header + ticket only via the @media print rules in styles/ticket.css. */}
          <div className="ticket-print-area">

          {isPaid ? (
            <section className="ticket-success-header">
              <div className="success-badge-circle">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
              </div>
              <h1 className="success-heading">
                Payment <span className="highlight-cyan">Successful!</span>
              </h1>
              {order.emailDelivery?.status === 'SENT' ? (
                <>
                  <p className="success-subtitle">
                    Your ticket has been generated. A copy has been sent to your registered email address
                    {order.emailDelivery.recipientMasked ? ` (${order.emailDelivery.recipientMasked})` : ''}.
                  </p>
                  <p className="success-note">
                    You can also retrieve it anytime from Orders. Keep this ticket handy when collecting your prints.
                  </p>
                </>
              ) : order.emailDelivery?.status === 'FAILED' ? (
                <>
                  <p className="success-subtitle" style={{ color: '#f87171' }}>
                    Your order was created and your ticket is available below. However, email delivery could not be completed at this time and needs retrying.
                  </p>
                  <div style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="ticket-btn ticket-btn-outline"
                      style={{ padding: '0.4rem 1rem', fontSize: '0.85rem' }}
                      disabled={retryingEmail}
                      onClick={handleRetryEmail}
                    >
                      {retryingEmail ? 'Retrying Email...' : 'Retry Email Delivery'}
                    </button>
                    {retryFeedback && (
                      <span style={{ fontSize: '0.85rem', color: retryFeedback.includes('successfully') ? '#4ade80' : '#f87171' }}>
                        {retryFeedback}
                      </span>
                    )}
                  </div>
                  <p className="success-note" style={{ marginTop: '0.75rem' }}>
                    You can retrieve your ticket anytime from Orders.
                  </p>
                </>
              ) : order.emailDelivery?.status === 'SENDING' || order.emailDelivery?.status === 'PENDING' ? (
                <>
                  <p className="success-subtitle">
                    Your ticket has been generated. We are sending a copy to your registered email address
                    {order.emailDelivery?.recipientMasked ? ` (${order.emailDelivery.recipientMasked})` : ''}.
                  </p>
                  <p className="success-note">
                    You can also retrieve it anytime from Orders. Keep this ticket handy when collecting your prints.
                  </p>
                </>
              ) : (
                <>
                  <p className="success-subtitle">Your collection ticket is ready.</p>
                  <p className="success-note">
                    You can also retrieve it anytime from Orders. Keep this ticket handy when collecting your prints.
                  </p>
                </>
              )}
            </section>
          ) : (
            <section className="ticket-success-header">
              <h1 className="success-heading">
                {header.title} — <span className="highlight-cyan">{header.highlight}</span>
              </h1>
              <p className="success-subtitle">{header.subtitle}</p>
              <p className="success-note">{header.note}</p>
            </section>
          )}

          <div className="ticket-card-wrapper">
            <div className="ticket-left-stub">
              <span className="stub-brand-text">CAMPUS PRINTS</span>
            </div>

            <div className="ticket-notch notch-top"></div>
            <div className="ticket-perforation-line"></div>
            <div className="ticket-notch notch-bottom"></div>

            <div className="ticket-main-body">
              <div className="ticket-microcopy">
                <span className="star-ornament">✦</span>
                <span>{isPaid ? 'YOUR COLLECTION TICKET' : 'ORDER REFERENCE'}</span>
                <span className="star-ornament">✦</span>
              </div>

              <div className="ticket-number-display">
                <h2 className="cp-ticket-code">
                  {isPaid ? (order.ticket_number || `CP-${String(order.id).padStart(3, '0')}`) : `Order #${order.id}`}
                </h2>
              </div>

              <div className="ticket-divider">
                <span className="divider-line"></span>
                <span className="divider-diamond">◆</span>
                <span className="divider-line"></span>
              </div>

              <div className="ticket-info-list">
                <div className="ticket-info-row">
                  <div className="info-icon-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                      <circle cx="12" cy="7" r="4"></circle>
                    </svg>
                  </div>
                  <div className="info-details">
                    <span className="info-label">NAME</span>
                    <span className="info-value">{displayName}</span>
                  </div>
                </div>

                <div className="ticket-info-row">
                  <div className="info-icon-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-2.18-2 2 2 0 0 1 2-2h19.5a2 2 0 0 1 2 2z"></path>
                      <line x1="8" y1="10" x2="16" y2="10"></line>
                    </svg>
                  </div>
                  <div className="info-details">
                    <span className="info-label">PHONE</span>
                    <span className="info-value">{displayPhone}</span>
                  </div>
                </div>

                <div className="ticket-info-row">
                  <div className="info-icon-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                    </svg>
                  </div>
                  <div className="info-details">
                    <span className="info-label">CLASS / SECTION</span>
                    <span className="info-value">{order?.guest_classroom || '—'}</span>
                  </div>
                </div>

                <div className="ticket-info-row">
                  <div className="info-icon-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                      <line x1="16" y1="13" x2="8" y2="13"></line>
                      <line x1="16" y1="17" x2="8" y2="17"></line>
                    </svg>
                  </div>
                  <div className="info-details">
                    <span className="info-label">TRANSACTION ID</span>
                    <span className="info-value font-mono">{isPaid && order?.payment ? order.payment.transaction_ref : '—'}</span>
                  </div>
                </div>

                <div className="ticket-info-row highlight-row">
                  <div className="info-icon-badge loc-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                      <circle cx="12" cy="10" r="3"></circle>
                    </svg>
                  </div>
                  <div className="info-details">
                    <span className="info-label label-accent">COLLECTION LOCATION</span>
                    <span className="info-value value-prominent">{order?.collection_location || '—'}</span>
                  </div>
                </div>

                <div className="ticket-info-row highlight-row">
                  <div className="info-icon-badge time-badge">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"></circle>
                      <polyline points="12 6 12 12 16 14"></polyline>
                    </svg>
                  </div>
                  <div className="info-details">
                    <span className="info-label label-accent">COLLECTION TIME</span>
                    <span className="info-value value-prominent">{order?.collection_time || '—'}</span>
                  </div>
                </div>

                {isPaid && (
                  <div className="ticket-info-row highlight-row delivery-row">
                    <div className="info-icon-badge loc-badge">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                        <circle cx="12" cy="7" r="4"></circle>
                      </svg>
                    </div>
                    <div className="info-details">
                      <span className="info-label label-accent">DELIVERY PERSON DETAILS</span>
                      {deliveryContact ? (
                        <>
                          <span className="info-value">Name: {deliveryContact.name}</span>
                          <span className="info-value">Phone: {deliveryContact.phoneDisplay}</span>
                        </>
                      ) : (
                        <span className="info-value">Delivery contact unavailable</span>
                      )}
                    </div>
                    {deliveryContact && (
                      <a className="delivery-call-btn" href={deliveryContact.telHref} aria-label={`Call ${deliveryContact.name}`}>
                        Call
                      </a>
                    )}
                  </div>
                )}
              </div>

              <div className="ticket-footer-note">
                <span className="script-thanks">Thank you for choosing Campus Prints!</span>
              </div>
            </div>
          </div>
          </div>

          <div className="ticket-reminder-box">
            <div className="reminder-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="16" x2="12" y2="12"></line>
                <line x1="12" y1="8" x2="12.01" y2="8"></line>
              </svg>
            </div>
            <div className="reminder-text">
              <p className="reminder-title">Reach on time to collect your prints.</p>
              <p className="reminder-desc">
                {isPaid ? 'Show this ticket at the collection counter.' : 'Show this order reference at the collection counter.'}
              </p>
            </div>
          </div>

          {!isPaid && STILL_OPEN_STATES.includes(order?.state) && (
            <div className="ticket-checking-indicator" style={{ textAlign: 'center', margin: '0.5rem 0 1rem', color: '#6b7280', fontSize: '0.85rem' }}>
              <span className="loading-spinner" style={{ display: 'inline-block', width: 14, height: 14, verticalAlign: 'middle', marginRight: 6 }} />
              Checking for updates...
            </div>
          )}

          <div className="ticket-action-buttons">
            {isPaid && (
              <button type="button" className="ticket-btn ticket-btn-outline" onClick={() => window.print()}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                <span>Download Ticket</span>
              </button>
            )}

            {!isPaid && order && (
              <button type="button" className="ticket-btn ticket-btn-outline" disabled={checking} onClick={() => setRecheckKey(k => k + 1)}>
                {checking
                  ? <><span className="loading-spinner" style={{ display: 'inline-block', width: 16, height: 16, verticalAlign: 'middle', marginRight: 6 }} />Checking...</>
                  : 'Check Payment Again'}
              </button>
            )}

            {!isPaid && order && (
              <Link to="/orders" className="ticket-btn ticket-btn-outline">My Orders</Link>
            )}

            <a href="/" className="ticket-btn ticket-btn-primary">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                <polyline points="9 22 9 12 15 12 15 22"></polyline>
              </svg>
              <span>Back to Home</span>
            </a>
          </div>

            </>
          )}
        </main>
      </div>
      <Footer />
    </>
  );
}
