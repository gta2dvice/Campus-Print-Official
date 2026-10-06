import { useEffect, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import PageBackground from '../components/PageBackground';
import Footer from '../components/Footer';
import LogoLink from '../components/LogoLink';
import useBodyClass from '../lib/useBodyClass';
import useDocumentTitle from '../lib/useDocumentTitle';
import '../styles/style.css';
import '../styles/dashboard.css';
import '../styles/ticket.css';

export default function Ticket() {
  useBodyClass('ticket-page-body');
  useDocumentTitle('Collection Ticket – Campus Prints');
  const [searchParams] = useSearchParams();
  const orderId = searchParams.get('id');
  const [order, setOrder] = useState(null);
  const [ticketError, setTicketError] = useState('');

  useEffect(() => {
    if (!orderId) {
      setTicketError('The order ID is missing from this ticket link.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        console.info('[TICKET_LOAD] Fetching ticket:', { orderId });
        const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}`, { credentials: 'include' });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.error('[TICKET_LOAD_FAILED]', {
            stage: 'ticket_lookup_response',
            orderId,
            httpStatus: res.status,
            code: data.code || 'TICKET_LOAD_FAILED'
          });
          if (!cancelled) setTicketError(data.message || `Ticket lookup failed (${res.status}).`);
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          console.info('[TICKET_LOAD] Ticket loaded:', { orderId, ticketNumberPresent: Boolean(data.ticket_number) });
          setOrder(data);
        }
      } catch (error) {
        console.error('[TICKET_LOAD_FAILED]', {
          stage: 'ticket_lookup_request',
          orderId,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        });
        if (!cancelled) setTicketError('Could not reach the server to load this ticket. Please retry.');
      }
    })();
    return () => { cancelled = true; };
  }, [orderId]);

  function maskPhone(phone) {
    if (!phone) return '—';
    if (phone.length < 10) return phone;
    return `${phone.slice(0, 3)}****${phone.slice(-3)}`;
  }

  const displayName = order?.guest_full_name || (order?.customer_email ? order.customer_email.split('@')[0] : 'Guest');

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

          <section className="ticket-success-header">
            <div className="success-badge-circle">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
            </div>
            <h1 className="success-heading">
              Payment <span className="highlight-cyan">Successful!</span>
            </h1>
            <p className="success-subtitle">Your collection ticket is ready.</p>
            <p className="success-note">Keep this ticket handy when collecting your prints.</p>
          </section>

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
                <span>YOUR COLLECTION TICKET</span>
                <span className="star-ornament">✦</span>
              </div>

              <div className="ticket-number-display">
                <h2 className="cp-ticket-code">{order ? (order.ticket_number || `CP-${String(order.id).padStart(3, '0')}`) : '—'}</h2>
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
                    <span className="info-value">{maskPhone(order?.guest_phone)}</span>
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
                    <span className="info-value font-mono">{order?.payment ? order.payment.transaction_ref : '—'}</span>
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
              </div>

              <div className="ticket-footer-note">
                <span className="script-thanks">Thank you for choosing Campus Prints!</span>
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
              <p className="reminder-desc">Show this ticket at the collection counter.</p>
            </div>
          </div>

          <div className="ticket-action-buttons">
            <button type="button" className="ticket-btn ticket-btn-outline" onClick={() => window.print()}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              <span>Download Ticket</span>
            </button>

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
