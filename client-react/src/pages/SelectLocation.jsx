import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import PageBackground from '../components/PageBackground';
import Footer from '../components/Footer';
import Toast from '../components/Toast';
import useToast from '../lib/useToast';
import useBodyClass from '../lib/useBodyClass';
import useDocumentTitle from '../lib/useDocumentTitle';
import LogoLink from '../components/LogoLink';
import { SLOT_LOCATIONS, TIME_SLOTS, isLocationOffered } from '../lib/slotAvailability';
import '../styles/style.css';
import '../styles/dashboard.css';

// Card icons per location id; names, hints and availability come from the shared slot matrix.
const LOCATION_ICONS = {
  'main-gate': <path d="M3 21V3h18v18M3 12h18M12 3v18" />,
  'red-canteen': <path d="M18 8h1a4 4 0 0 1 0 8h-1M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8zM6 1v3M10 1v3M14 1v3" />,
  'hostel-gate': (
    <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></>
  ),
  'academic-block': (
    <><path d="M3 21h18M3 7v14M21 7v14M9 7v14M15 7v14M3 7h18M3 11h18M3 15h18" /><rect x="2" y="2" width="20" height="20" rx="2" /></>
  ),
};
const LOCATIONS = SLOT_LOCATIONS.map((loc) => ({ ...loc, sub: loc.hint, icon: LOCATION_ICONS[loc.id] }));
const SLOT_CUTOFF_MINUTES = 5;
const LIVE_SLOT_AVAILABILITY = false;

// Campus Print only operates in India, so slot cutoffs always use IST — regardless of the
// student's device timezone. Comparing minutes-since-midnight avoids local-Date pitfalls.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function nowMinutesIST() {
  return Math.floor(((Date.now() + IST_OFFSET_MS) % 86400000) / 60000);
}
function slotMinutes(time) {
  const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(time.trim());
  if (!match) return 0;
  let [, hourStr, minStr, meridiem] = match;
  let hour = parseInt(hourStr, 10) % 12;
  if (meridiem.toUpperCase() === 'PM') hour += 12;
  return hour * 60 + parseInt(minStr, 10);
}

function isSlotPast(time) {
  if (!LIVE_SLOT_AVAILABILITY) return false;
  return nowMinutesIST() >= slotMinutes(time) - SLOT_CUTOFF_MINUTES;
}

const ORDER_SUMMARY = [
  { label: 'Uploaded Documents', value: 'Assignment_Final.pdf, Lab_Report.docx' },
  { label: 'Print Option', value: 'B&W (₹2 / page)' },
  { label: 'Paper & Copies', value: 'A4 · 1 Copy (10 pages)' },
];

export default function SelectLocation() {
  useBodyClass('booking-flow-body');
  useDocumentTitle('Select Location & Time Slot – Print Campus');
  const { toast, showToast } = useToast();

  const [step, setStep] = useState('slot');
  const [locationId, setLocationId] = useState(null);
  const [locationName, setLocationName] = useState(null);
  const [timeSlot, setTimeSlot] = useState(null);
  const [slots, setSlots] = useState([]);
  const [locationStatuses, setLocationStatuses] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [paying, setPaying] = useState(false);

  function selectTime(time) {
    setTimeSlot(time);
    if (locationId && !isLocationOffered(locationId, time)) {
      setLocationId(null);
      setLocationName(null);
    }
  }

  async function goToStep(nextStep) {
    setStep(nextStep);
    if (nextStep === 'slot') {
      setSlotsLoading(true);
      let slotsData = [];
      try {
        const res = await fetch('/api/orders/slots');
        if (res.ok) {
          const data = await res.json();
          slotsData = data.slots || [];
        }
      } catch {
        // fall through
      }
      if (!slotsData.length) {
        slotsData = TIME_SLOTS.map((time) => ({
          time,
          status: isSlotPast(time) ? 'past' : 'available',
        }));
      }
      setSlots(slotsData);
      setSlotsLoading(false);
    }
    if (nextStep === 'location') {
      setSlotsLoading(true);
      let locationsData = [];
      try {
        const res = await fetch(`/api/orders/slots?time=${encodeURIComponent(timeSlot)}`);
        if (res.ok) {
          const data = await res.json();
          locationsData = data.locations || [];
        }
      } catch {
        // fall through
      }
      if (!locationsData.length && timeSlot) {
        const past = isSlotPast(timeSlot);
        locationsData = LOCATIONS.map((loc) => {
          const offered = isLocationOffered(loc.id, timeSlot);
          if (!offered) return { id: loc.id, status: 'unavailable' };
          if (past) return { id: loc.id, status: 'past' };
          return { id: loc.id, status: 'available' };
        });
      }
      setLocationStatuses(locationsData);
      setSlotsLoading(false);
    }
  }

  useEffect(() => {
    goToStep('slot');
    // load first step on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handlePay() {
    setPaying(true);
    setTimeout(() => {
      showToast('Order confirmed! Booking simulation successful. 🎉', 'success');
      setPaying(false);
    }, 1200);
  }

  return (
    <div className="page-content" style={{ position: 'relative' }}>
      <PageBackground />
      <LogoLink />
      <main className="booking-container reveal-wrapper" style={{ maxWidth: 1000, margin: '3rem auto', minHeight: 'calc(100vh - 6rem)' }}>
        <div className="booking-orb booking-orb-1"></div>
        <div className="booking-orb booking-orb-2"></div>

        <div className="booking-inner-content">

          <div className="cp-nav-steps" role="navigation" aria-label="Booking steps">
            <button type="button" className={`cp-nav-step${step === 'slot' ? ' is-active' : ''}${step === 'location' || step === 'review' ? ' is-done' : ''}`} onClick={() => goToStep('slot')}>
              <span className="step-num">01</span><span className="step-title">Time Slot</span>
            </button>
            <span className="step-arrow">→</span>
            <button
              type="button"
              className={`cp-nav-step${step === 'location' ? ' is-active' : ''}${step === 'review' ? ' is-done' : ''}`}
              onClick={() => timeSlot && goToStep('location')}
            >
              <span className="step-num">02</span><span className="step-title">Location</span>
            </button>
            <span className="step-arrow">→</span>
            <button
              type="button"
              className={`cp-nav-step${step === 'review' ? ' is-active' : ''}`}
              onClick={() => locationId && timeSlot && goToStep('review')}
            >
              <span className="step-num">03</span><span className="step-title">Review</span>
            </button>
          </div>

          {step === 'slot' && (
            <section className="cp-step-view">
              <div className="cp-view-header">
                <span className="location-tag">🕒 Pickup Schedule</span>
                <h1 className="location-title" style={{ marginTop: '0.5rem' }}>Choose your collection time</h1>
                <p className="location-subtitle">Select a time first. Pickup points for that slot are shown next.</p>
              </div>

              {slotsLoading ? (
                <p style={{ fontSize: '0.9rem', color: 'var(--text-muted)' }}>Loading slots…</p>
              ) : (
                <div className="cp-slots-grid">
                  {slots.map((s) => {
                    const isPast = s.status === 'past';
                    const isFull = s.status === 'full';
                    const isLimited = s.status === 'limited';
                    const isDisabled = isPast || isFull;
                    const isSelected = timeSlot === s.time;
                    // Still selectable: picking it clears the chosen location (see selectTime).
                    const notAtSelectedLocation = !!locationId && !isLocationOffered(locationId, s.time);
                    let statusLabel = 'Available';
                    if (isPast) statusLabel = 'Unavailable';
                    else if (isFull) statusLabel = 'Fully Booked';
                    else if (notAtSelectedLocation) statusLabel = `Not at ${locationName}`;
                    else if (isLimited) statusLabel = 'Limited';
                    let classes = 'cp-slot-pill';
                    if (isPast) classes += ' is-past';
                    else if (isFull) classes += ' is-full';
                    else if (isLimited || notAtSelectedLocation) classes += ' is-limited';
                    else classes += ' is-available';
                    if (isSelected) classes += ' is-selected';
                    return (
                      <button key={s.time} type="button" className={classes} disabled={isDisabled} onClick={() => selectTime(s.time)}>
                        <span className="cp-slot-time-text">{s.time}</span>
                        <span className="cp-slot-tag">{statusLabel}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="cp-step-footer">
                <button type="button" className="btn btn-primary" disabled={!timeSlot} onClick={() => goToStep('location')}>
                  Continue to Location <span className="arrow-icon">→</span>
                </button>
              </div>
            </section>
          )}

          {step === 'location' && (
            <section className="cp-step-view">
              <div className="cp-view-header">
                <span className="location-tag">📍 Collection Point</span>
                <h1 className="location-title" style={{ marginTop: '0.5rem' }}>Where should we deliver your prints?</h1>
                <p className="location-subtitle">Pickup at <strong style={{ color: 'var(--primary-blue-hover, #2563eb)' }}>{timeSlot || '—'}</strong>. Points not served at this time are unavailable.</p>
              </div>

              <div className="cp-cards-grid">
                {LOCATIONS.map((loc) => {
                  const locStatus = locationStatuses.find((l) => l.id === loc.id);
                  const status = locStatus?.status || 'unavailable';
                  const isUnavailable = status === 'unavailable' || status === 'past';
                  const isFull = status === 'full';
                  const isLimited = status === 'limited';
                  const isDisabled = isUnavailable || isFull;
                  let statusLabel = 'Available';
                  if (isUnavailable) statusLabel = 'Booked';
                  else if (isFull) statusLabel = 'Fully Booked';
                  else if (isLimited) statusLabel = 'Limited';
                  let classes = 'cp-loc-card';
                  if (loc.id === locationId && !isDisabled) classes += ' is-selected';
                  if (isDisabled) classes += ' is-unavailable';
                  return (
                    <button
                      key={loc.id}
                      type="button"
                      className={classes}
                      disabled={isDisabled}
                      onClick={() => {
                        if (timeSlot && !isLocationOffered(loc.id, timeSlot)) return;
                        setLocationId(loc.id);
                        setLocationName(loc.name);
                      }}
                    >
                      <div className="cp-card-icon">
                        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{loc.icon}</svg>
                      </div>
                      <h3 className="cp-card-title">{loc.name}</h3>
                      <p className="cp-card-sub">{loc.sub}</p>
                      <span className="cp-loc-status-tag">{statusLabel}</span>
                    </button>
                  );
                })}
              </div>

              <div className="cp-step-footer space-between">
                <button type="button" className="btn btn-secondary" onClick={() => goToStep('slot')}>← Back to Time Slot</button>
                <button type="button" className="btn btn-primary" disabled={!locationId} onClick={() => goToStep('review')}>
                  Continue to Review <span className="arrow-icon">→</span>
                </button>
              </div>
            </section>
          )}

          {step === 'review' && (
            <section className="cp-step-view">
              <div className="cp-view-header">
                <span className="location-tag">✨ Confirm Details</span>
                <h1 className="location-title" style={{ marginTop: '0.5rem' }}>Review your booking</h1>
                <p className="location-subtitle">Confirm pickup details before proceeding to payment.</p>
              </div>

              <div className="cp-review-container">
                <div className="cp-review-box">
                  <h3 className="cp-review-heading">Collection Details</h3>
                  <div className="cp-review-row">
                    <div>
                      <span className="cp-review-label">Collection Location</span>
                      <strong className="cp-review-val">{locationName || '—'}</strong>
                    </div>
                    <button type="button" className="cp-inline-edit" onClick={() => goToStep('location')}>Edit Location</button>
                  </div>
                  <div className="cp-review-row">
                    <div>
                      <span className="cp-review-label">Collection Time</span>
                      <strong className="cp-review-val">{timeSlot || '—'}</strong>
                    </div>
                    <button type="button" className="cp-inline-edit" onClick={() => goToStep('slot')}>Edit Time</button>
                  </div>
                </div>

                <div className="cp-review-box">
                  <h3 className="cp-review-heading">Order Summary</h3>
                  <div className="cp-review-details-list">
                    {ORDER_SUMMARY.map((line) => (
                      <div className="cp-review-line" key={line.label}><span>{line.label}</span><strong>{line.value}</strong></div>
                    ))}
                  </div>
                  <div className="cp-review-total">
                    <span>Total Amount</span>
                    <strong>₹40</strong>
                  </div>
                </div>
              </div>

              <div className="cp-step-footer space-between" style={{ marginTop: '2rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => goToStep('location')}>← Back to Location</button>
                <button type="button" className="btn btn-primary" disabled={paying} onClick={handlePay}>
                  {paying ? (
                    <><span className="loading-spinner"></span>&nbsp; Processing Payment…</>
                  ) : (
                    <>Proceed to Payment <span className="arrow-icon">→</span></>
                  )}
                </button>
              </div>
            </section>
          )}

        </div>
      <Footer />
      </main>
      <Toast toast={toast} />
    </div>
  );
}
