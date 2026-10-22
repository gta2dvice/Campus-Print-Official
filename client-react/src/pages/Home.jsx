import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import PageBackground from '../components/PageBackground';
import Footer from '../components/Footer';
import GuestDetailsModal from '../components/GuestDetailsModal';
import useDocumentTitle from '../lib/useDocumentTitle';
import { countPdfPages } from '../lib/pdfWorker';
import {
  MAX_FILE_BYTES,
  MAX_ORDER_FILES,
  flushSaveCurrentOrder,
  loadCurrentOrder,
  saveCurrentOrder,
  scheduleSaveCurrentOrder,
  storageErrorMessage,
} from '../lib/orderStorage';
import { printablePages, parsePageRange, showPageRangeInput, hasInvalidPageRange } from '../lib/pageRange';
import '../styles/style.css';

const STUDENTS = [
  { name: 'Divye', branch: 'CSE Core', color: '59, 130, 246', review: 'Very fast printing and affordable pricing. Saved my semester submissions!' },
  { name: 'Kartike', branch: 'CSE AI-ML', color: '249, 115, 22', review: 'Upload system is smooth and no more long queues.' },
  { name: 'Ananya', branch: 'Mechanical', color: '20, 184, 166', review: 'Clean prints and very quick service inside campus.' },
  { name: 'Bhargavii', branch: 'BCA', color: '239, 68, 68', review: 'Very fast printing and affordable pricing. Saved my semester submissions!' },
  { name: 'Kush', branch: 'CSE Core', color: '139, 92, 246', review: 'Upload system is smooth and no more long queues.' },
  { name: 'Vartika', branch: 'CSE AI-ML', color: '56, 189, 248', review: 'Upload system is smooth and no more long queues.' },
];

const ALLOWED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'image/png',
  'image/jpeg',
  'image/jpg',
];
const ALLOWED_EXTENSIONS = /\.(pdf|docx|doc|pptx|ppt|xlsx|xls|png|jpg|jpeg)$/i;
const ACCEPT_ATTR = '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.jpg,.jpeg,.png';
const SUPPORTED_LABEL = 'PDF, DOC, DOCX, PPT, PPTX, XLS, XLSX, JPG, PNG';

function isSupportedFile(file) {
  if (!file) return false;
  if (file.type && ALLOWED_TYPES.includes(file.type.toLowerCase())) return true;
  if (file.name && ALLOWED_EXTENSIONS.test(file.name)) return true;
  return false;
}

function isImageFile(file) {
  return (file.type && file.type.startsWith('image/')) || /\.(png|jpg|jpeg)$/i.test(file?.name || '');
}

function smoothScrollToElement(target) {
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
  window.scrollTo({ top: rect.top + scrollTop - 40, behavior: 'smooth' });
}

export default function Home() {
  useDocumentTitle('Print Campus - Skip Queue');
  const navigate = useNavigate();
  const [modalOpen, setModalOpen] = useState(false);
  const [lastTicketToken, setLastTicketToken] = useState('');
  const heroTextRef = useRef(null);
  const fileInputRef = useRef(null);

  const [files, setFiles] = useState([]); // [{ key, file, pages, estimated, copies, printingSide, colorMode }]
  const [size, setSize] = useState('A4');
  const [printingSide, setPrintingSide] = useState('single');
  const [classroomDelivery, setClassroomDelivery] = useState(false); // Verified state

  const [bump, setBump] = useState(false);
  // Unresolved (pending/unknown) payment left over from a previous visit. Kept in
  // localStorage as recovery data. The homepage recovery UI was removed; recovery is
  // surfaced from the Orders page instead.
  const [pendingPaymentId, setPendingPaymentId] = useState('');
  const persistReadyRef = useRef(false);
  const extraMetaRef = useRef({
    guestDetails: null,
    spiralBinding: false,
    expressDelivery: false,
    selectedLocationId: null,
    selectedLocationName: null,
    selectedTimeSlot: null,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let pendingPayment = null;
      try {
        pendingPayment = JSON.parse(localStorage.getItem('cp_pending_payment') || 'null');
      } catch {
        localStorage.removeItem('cp_pending_payment');
      }
      const ticketToken = localStorage.getItem('cp_last_ticket') || '';
      if (/^[a-f0-9]{64}$/i.test(ticketToken)) setLastTicketToken(ticketToken);
      if (cancelled || !pendingPayment?.cashfreeOrderId) return;

      // Ask the SERVER whether this payment is resolved. The answer is used ONLY to
      // clean up terminal states — pending, unknown, or unreachable verifications
      // must never hijack the homepage with an automatic redirect into the payment
      // confirmation screen.
      let data = null;
      let httpStatus = 0;
      try {
        const res = await fetch('/api/orders/payment/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ cashfree_order_id: pendingPayment.cashfreeOrderId }),
        });
        httpStatus = res.status;
        data = await res.json().catch(() => ({}));
      } catch {
        // Network error: payment state is genuinely uncertain — keep the flag, recover below.
      }
      if (cancelled) return;

      const status = data?.status;
      if (status === 'PAID') {
        // Terminal: the money is captured. Clear the stale recovery marker and
        // expose the existing paid order's ticket link.
        localStorage.removeItem('cp_pending_payment');
        if (typeof data.ticketToken === 'string' && /^[a-f0-9]{64}$/i.test(data.ticketToken)) {
          localStorage.setItem('cp_last_ticket', data.ticketToken);
          setLastTicketToken(data.ticketToken);
        }
        return;
      }
      if (status === 'NOT_FOUND' || status === 'PAYMENT_FAILED' || httpStatus === 400) {
        // This attempt can never complete (no order / rejected by gateway / malformed id).
        // The unpaid order itself stays on the Orders page with Pay Again — nothing
        // genuinely unresolved is discarded.
        localStorage.removeItem('cp_pending_payment');
        return;
      }
      // PAYMENT_PENDING / PROCESSING / gateway errors / unreachable backend:
      // unresolved — keep the recovery data and offer an explicit, optional action
      // instead of redirecting. The homepage stays fully usable.
      setPendingPaymentId(pendingPayment.cashfreeOrderId);
    })();
    return () => { cancelled = true; };
  }, []);

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  async function countPdfPagesClient(file) {
    if (file.type !== 'application/pdf') return null;
    try {
      const buffer = await file.arrayBuffer();
      const text = new TextDecoder('latin1').decode(new Uint8Array(buffer));
      const counts = [...text.matchAll(/\/Count\s+(\d+)/gi)]
        .map((m) => parseInt(m[1], 10))
        .filter((c) => !isNaN(c) && c > 0);
      if (counts.length > 0) {
        return Math.max(...counts);
      }
      const pageMatches = [...text.matchAll(/\/Type\s*\/Page\b/gi)];
      if (pageMatches.length > 0) return pageMatches.length;
    } catch {
      // ignore
    }
    return null;
  }

  async function addFiles(newFiles) {
    const accepted = [];
    for (const file of newFiles) {
      if (files.length + accepted.length >= MAX_ORDER_FILES) {
        alert('Max 10 files allowed.');
        break;
      }
      if (!isSupportedFile(file)) {
        alert(`${file.name}: unsupported type. Supported: ${SUPPORTED_LABEL}.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        alert(`${file.name}: files must be 20 MB or smaller.`);
        continue;
      }
      // Images are one page; PDFs get a client-side guess; other docs are counted by the server.
      const clientPages = isImageFile(file) ? 1 : await countPdfPages(file);
      accepted.push({
        key: Math.random(),
        file,
        pages: clientPages || null,
        estimated: false,
        copies: 1,
        printingSide: 'single',
        colorMode: 'bw',
        spiralBinding: false,
        pageRange: ''
      });
    }
    if (accepted.length === 0) return;
    setFiles((prev) => [...prev, ...accepted]);
    detectPagesFor(accepted);
  }

  async function detectPagesFor(newlyAdded) {
    const needDetection = newlyAdded.filter((n) => n.pages === null);
    if (needDetection.length === 0) return;

    const formData = new FormData();
    needDetection.forEach((entry) => formData.append('files', entry.file));
    try {
      const res = await fetch('/api/orders/detect-pages', {
        method: 'POST', credentials: 'include', body: formData
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const results = data.files;
      if (Array.isArray(results)) {
        setFiles((prev) => prev.map((entry) => {
          const idx = needDetection.findIndex((n) => n.key === entry.key);
          if (idx === -1) return entry;
          const result = results[idx];
          if (result && typeof result.pages === 'number' && result.pages >= 1) {
            return { ...entry, pages: result.pages, estimated: !!result.estimated };
          }
          return { ...entry, pages: entry.pages || 1, estimated: true };
        }));
      }
    } catch {
      setFiles((prev) => prev.map((entry) =>
        needDetection.some((n) => n.key === entry.key) ? { ...entry, pages: entry.pages || 1, estimated: true } : entry
      ));
    }
  }

  function removeFile(key) {
    setFiles((prev) => prev.filter((f) => f.key !== key));
  }

  function clearAllFiles() {
    if (files.length === 0) return;
    if (!window.confirm('Clear all uploaded files from this unfinished order?')) return;
    setFiles([]);
  }

  function updateFileColorMode(key, mode) {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, colorMode: mode } : f)));
  }

  function updateFilePageRange(key, value) {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, pageRange: value } : f)));
  }
  function updateFilePrintingSide(key, side) {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, printingSide: side } : f)));
  }

  function updateFileBinding(key, spiralBinding) {
    setFiles((prev) => prev.map((f) => {
      if (f.key !== key) return f;
      // Force binding to false if printable pages < 5
      const isEligible = printablePages(f) >= 5;
      return { ...f, spiralBinding: isEligible ? spiralBinding : false };
    }));
  }

  function updateFileCopies(key, delta) {
    if (delta < 0) {
      const target = files.find((f) => f.key === key);
      // Minus at 1 copy removes the document — reuses the existing deletion path
      // (state, totals, pricing and the stored draft all follow along).
      if (target && (target.copies || 1) <= 1) {
        removeFile(key);
        return;
      }
    }
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, copies: Math.max(1, f.copies + delta) } : f)));
  }

  const totalPages = files.reduce((sum, f) => sum + (printablePages(f) * f.copies), 0);

  function calcPrice() {
    // Same rule as NewOrder.jsx / server: B&W double-sided is per physical sheet (2 pages per sheet).
    const printingSubtotal = files.reduce((sum, f) => {
      const pages = printablePages(f);
      const copies = f?.copies || 1;
      if (f?.colorMode === 'color') return sum + pages * copies * 5;
      if (f?.printingSide === 'double') return sum + Math.ceil(pages / 2) * copies * 3;
      return sum + pages * copies * 2;
    }, 0);

    const deliveryCharge = classroomDelivery ? 5 : 0;
    const bindingCharge = files.reduce((sum, file) => sum + (file.spiralBinding ? 26 : 0), 0);

    // Tiered Service Charge (Slabs) matching NewOrder.jsx and server/pricing.js
    let serviceCharge = 0;
    if (totalPages > 0) {
      if (totalPages <= 10) serviceCharge = 1;
      else if (totalPages <= 30) serviceCharge = 2;
      else serviceCharge = 3;
    }

    return {
      basePrice: printingSubtotal,
      a3Extra: 0,
      deliveryCharge,
      bindingCharge,
      serviceCharge,
      total: printingSubtotal + deliveryCharge + bindingCharge + serviceCharge
    };
  }

  const { basePrice, a3Extra, deliveryCharge, bindingCharge, serviceCharge, total } = calcPrice();

  function getFileCost(f) {
    const pages = printablePages(f);
    const copies = f?.copies || 1;
    if (pages === 0) return 0;
    if (f?.colorMode === 'color') return pages * copies * 5;
    if (f?.printingSide === 'double') return Math.ceil(pages / 2) * copies * 3;
    return pages * copies * 2;
  }

  const isDetectingPages = files.some((f) => f.pages === null);
  const hasRangeErrors = files.some((f) => hasInvalidPageRange(f));
  const canOrder = files.length > 0 && !isDetectingPages && !hasRangeErrors;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const unfinished = await loadCurrentOrder();
      if (cancelled) return;
      if (unfinished) {
        const restoredFiles = Array.isArray(unfinished.files) ? unfinished.files : [];
        if (unfinished.spiralBinding && restoredFiles.length && !restoredFiles.some((file) => file.spiralBinding)) {
          restoredFiles[0] = { ...restoredFiles[0], spiralBinding: true };
        }
        extraMetaRef.current = {
          guestDetails: unfinished.guestDetails,
          spiralBinding: restoredFiles.some((file) => file.spiralBinding),
          expressDelivery: unfinished.expressDelivery,
          selectedLocationId: unfinished.selectedLocationId,
          selectedLocationName: unfinished.selectedLocationName,
          selectedTimeSlot: unfinished.selectedTimeSlot,
          classroomDelivery: unfinished.classroomDelivery,
        };
        if (restoredFiles.length) setFiles(restoredFiles);
        setSize('A4');
        setPrintingSide(unfinished.printingSide);
        setClassroomDelivery(unfinished.classroomDelivery || false);
      }
      try {
        const savedGuest = JSON.parse(localStorage.getItem('cp_guest_details') || 'null');
        if (savedGuest && !extraMetaRef.current.guestDetails) {
          extraMetaRef.current.guestDetails = savedGuest;
        }
      } catch {
        // localStorage unavailable
      }
      persistReadyRef.current = true;
    })();
    return () => {
      cancelled = true;
      persistReadyRef.current = false;
      flushSaveCurrentOrder().catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!persistReadyRef.current) return;
    scheduleSaveCurrentOrder({
      meta: {
        ...extraMetaRef.current,
        paperSize: size,
        printingSide,
        spiralBinding: files.some((file) => file.spiralBinding),
        classroomDelivery,
      },
      files,
      onError: (err) => alert(storageErrorMessage(err)),
    });
  }, [files, size, printingSide, classroomDelivery]);

  useEffect(() => {
    setBump(true);
    const t = setTimeout(() => setBump(false), 300);
    return () => clearTimeout(t);
  }, [total]);

  // ── Hero scroll blur/fade ──
  useEffect(() => {
    function onScroll() {
      const scrolled = window.scrollY;
      const vh = window.innerHeight;
      const blurPower = Math.min((scrolled / vh) * 20, 20);
      document.documentElement.style.setProperty('--hero-blur', `${blurPower}px`);
      if (heroTextRef.current && scrolled < vh) {
        const opacity = Math.max(0, 1 - scrolled / (vh * 0.6));
        const scale = 1 - scrolled / (vh * 5);
        heroTextRef.current.style.opacity = opacity;
        heroTextRef.current.style.transform = `scale(${scale})`;
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // ── Reveal-on-scroll + GPU hints + pause orbit when tab hidden + section spy ──
  useEffect(() => {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => { if (entry.isIntersecting) entry.target.classList.add('reveal-show'); });
    }, { threshold: 0.15, rootMargin: '0px 0px -80px 0px' });
    document.querySelectorAll('.reveal').forEach((el) => revealObserver.observe(el));

    document.querySelectorAll('.trusted-card').forEach((card) => { card.style.willChange = 'transform'; });
    const heroContainer = document.querySelector('.hero-container');
    if (heroContainer) heroContainer.style.willChange = 'filter';

    function onVisibility() {
      const orbit = document.querySelector('.trusted-orbit');
      if (!orbit) return;
      orbit.style.animationPlayState = document.hidden ? 'paused' : 'running';
    }
    document.addEventListener('visibilitychange', onVisibility);

    const sections = document.querySelectorAll('section[id]');
    const navLinks = document.querySelectorAll('.top-nav a[href^="#"]');
    let sectionSpy = null;
    if (sections.length && navLinks.length) {
      const linkById = new Map();
      navLinks.forEach((link) => {
        const href = link.getAttribute('href');
        if (href && href.startsWith('#')) linkById.set(href.slice(1), link);
      });
      sectionSpy = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const activeLink = linkById.get(entry.target.id);
          if (!activeLink) return;
          navLinks.forEach((link) => link.classList.remove('nav-link--active'));
          activeLink.classList.add('nav-link--active');
        });
      }, { threshold: 0.45, rootMargin: '-10% 0px -55% 0px' });
      sections.forEach((section) => sectionSpy.observe(section));
    }

    return () => {
      revealObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      if (sectionSpy) sectionSpy.disconnect();
    };
  }, []);

  async function handleUploadClick(e) {
    e.preventDefault();
    setModalOpen(true);
  }

  function scrollToId(id) {
    smoothScrollToElement(document.getElementById(id));
  }

  async function persistHomeOrder(guestDetails) {
    const meta = {
      ...extraMetaRef.current,
      guestDetails: guestDetails || extraMetaRef.current.guestDetails,
      paperSize: size,
      printingSide,
      spiralBinding: files.some((file) => file.spiralBinding),
      classroomDelivery,
    };
    extraMetaRef.current = meta;
    await saveCurrentOrder({
      meta,
      files: files.map(f => ({ ...f, printingSide: f.printingSide || printingSide }))
    });
  }

  async function handleOrderClick() {
    const invalidRange = files.find((f) => hasInvalidPageRange(f));
    if (invalidRange) {
      alert(`Fix the page range for “${invalidRange.file.name}” before continuing.`);
      return;
    }
    try {
      localStorage.setItem('cp_pending_order', JSON.stringify({
        size, printingSide,
      }));
    } catch {
      // localStorage unavailable
    }
    try {
      await persistHomeOrder();
    } catch (err) {
      alert(storageErrorMessage(err));
    }
    setModalOpen(true);
  }

  return (
    <>
      <PageBackground />
      <div className="page-content">

        {/* ── STICKY HERO ── */}
        <div className="hero-container" id="hero">
          <header className="top-nav">
            <nav>
              <Link to="/about" className="nav-link">About Us</Link>
              <Link to="/orders" className="nav-link">Orders</Link>
            </nav>
          </header>

          <div className="hero-content" id="heroText" ref={heroTextRef}>
            <h1 className="hero-title">CAMPUS PRINT</h1>
            <p className="hero-subtitle">Your ideas, printed fast &amp; affordably</p>

            <div className="cta-buttons">
              <button className="btn btn-primary" id="uploadBtn" onClick={handleUploadClick}>
                Upload Your Project
                <span className="arrow-icon">→</span>
              </button>
              <button className="btn btn-secondary" id="seePricingBtn" type="button" onClick={(e) => { e.preventDefault(); scrollToId('pricing-section'); }}>
                See Services &amp; Pricing
              </button>
            </div>
          </div>

        </div>

        {/* ── SLIDING CONTENT ── */}
        <main className="reveal-wrapper" id="main-content">

          {/* SECTION 1: Location */}
          <section className="location-section reveal" id="location-section">
            <div className="location-inner">
              <div className="location-text">
                <span className="location-tag">📍 Find Us</span>
                <h2 className="location-title">Your Prints.<br /> At Our Campus.</h2>
                <p className="location-subtitle">
                  No need to leave campus for your prints. We handle the printing and deliver your order right to you inside the college.
                </p>
                <div className="location-details">
                  <div className="location-detail-item">
                    <span className="detail-icon">🏛️</span>
                    <div>
                      <strong>Delivery Points</strong>
                      <p>1. Main Gate<br />2. Academic Block<br />3. Hostel Gate<br />4. Red Canteen</p>
                    </div>
                  </div>
                  <div className="location-detail-item">
                    <span className="detail-icon">🕐</span>
                    <div>
                      <strong>Hours</strong>
                      <p>Mon –Fri: 9:00 AM – 4:00 PM<br /></p>
                    </div>
                  </div>
                  <div className="location-detail-item">
                    <span className="detail-icon">📞</span>
                    <div>
                      <strong>Contact</strong>
                      <p>+91 8076756723<br />orders@campusprint.shop</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="location-map-card">
                <img
                  src="/thumbs-up-cat.jpg"
                  alt="Thumbs up cat"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    borderRadius: '28px',
                    display: 'block'
                  }}
                />
              </div>
            </div>
          </section>

          {/* SECTION 2: Trusted by Students */}
          <section className="trusted-section reveal">
            <div className="trusted-inner">
              <h2 className="trusted-title">Trusted by Students</h2>
              <p className="trusted-subtitle">
                Join hundreds of students who rely on Print Campus for fast, reliable prints.
              </p>

              <div className="trusted-wrapper">
                <div className="trusted-orbit" style={{ '--quantity': 6 }}>
                  {STUDENTS.map((s, i) => (
                    <div key={s.name} className="trusted-card" style={{ '--index': i, '--color-card': s.color }}>
                      <div className="trusted-card-bg"></div>
                      <div className="trusted-card-content">
                        <h3 className="student-name">{s.name}</h3>
                        <p className="student-branch">{s.branch}</p>
                        <p className="student-rating">⭐⭐⭐⭐⭐</p>
                        <p className="student-review">{s.review}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* SECTION 3: Pricing */}
          <section className="pricing-section reveal" id="pricing-section">
            <div className="pricing-orb pricing-orb-1"></div>
            <div className="pricing-orb pricing-orb-2"></div>

            <div className="pricing-inner">
              <div className="pricing-header">
                <span className="pricing-tag">💰 Transparent Pricing</span>
                <h2 className="pricing-title">Simple &amp; Affordable</h2>
                <p className="pricing-subtitle">
                  No hidden charges. Upload your PDFs below and see your estimated cost instantly.
                </p>
              </div>

              <div className="pricing-cards-row">
                <div className="pricing-card" id="pcColorCard">
                  <div className="pc-icon">🖨️</div>
                  <h3 className="pc-title">Printing Color</h3>
                  <div className="pc-info-list">
                    <div className="pc-info-row"><span>Black &amp; White</span><span className="pc-info-price">₹2 / page</span></div>
                    <div className="pc-info-row"><span>Color</span><span className="pc-info-price">₹5 / page</span></div>
                  </div>
                </div>

                <div className="pricing-card" id="pcPaperCard">
                  <div className="pc-icon">📄</div>
                  <h3 className="pc-title">Paper &amp; Printing Sides</h3>
                  <div className="pc-info-list">
                    <div className="pc-info-row"><span>Paper size</span><span className="pc-info-price">A4 only</span></div>
                    <div className="pc-info-row"><span>Single-sided</span><span className="pc-info-price">₹2 / page</span></div>
                    <div className="pc-info-row"><span>Double-sided B&amp;W</span><span className="pc-info-price">₹3 / sheet</span></div>
                    <div className="pc-info-row"><span>Double-sided color</span><span className="pc-info-price">₹5 / page</span></div>
                  </div>
                </div>

                <div className="pricing-card" id="pcAddonsCard">
                  <div className="pc-icon">✨</div>
                  <h3 className="pc-title">Add-ons</h3>
                  <div className="pc-info-list">
                    <div className="pc-info-row"><span>Pickup at Point</span><span className="pc-info-price">Free</span></div>
                    <div className="pc-info-row"><span>Classroom Delivery</span><span className="pc-info-price">₹5</span></div>
                    <div className="pc-info-row"><span>Binding</span><span className="pc-info-price">₹26 / PDF</span></div>
                  </div>
                </div>
              </div>

              <div className="upload-interactive-section" style={{ marginTop: '2.5rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem' }}>
                  <div className="home-options-grid" role="radiogroup" aria-label="Pickup and delivery option">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={!classroomDelivery}
                      className={`home-option-card ${!classroomDelivery ? 'is-selected' : ''}`}
                      onClick={() => setClassroomDelivery(false)}
                    >
                      <span className="home-radio-circle" aria-hidden="true">
                        <span className="home-radio-dot" />
                      </span>
                      <div className="home-option-text">
                        <span className="home-option-name">Pickup at Point</span>
                        <span className="home-option-price">Free</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={classroomDelivery}
                      className={`home-option-card ${classroomDelivery ? 'is-selected' : ''}`}
                      onClick={() => setClassroomDelivery(true)}
                    >
                      <span className="home-radio-circle" aria-hidden="true">
                        <span className="home-radio-dot" />
                      </span>
                      <div className="home-option-text">
                        <span className="home-option-name">Classroom Delivery</span>
                        <span className="home-option-price">+₹5</span>
                      </div>
                    </button>
                  </div>
                </div>

                {/* Upload Zone */}
                <div
                  className="home-upload-zone"
                  tabIndex={0}
                  role="button"
                  aria-label="Upload your files"
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                  onDragOver={(e) => { e.preventDefault(); }}
                  onDrop={(e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept={ACCEPT_ATTR}
                    style={{ display: 'none' }}
                    onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }}
                  />
                  <div className="home-upload-icon-wrap" aria-hidden="true">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="17 8 12 3 7 8"></polyline>
                      <line x1="12" y1="3" x2="12" y2="15"></line>
                    </svg>
                  </div>
                  <h3 className="home-upload-title">Upload your PDFs</h3>
                  <p className="home-upload-subtitle">Select files to get an instant print estimate.</p>
                  <button type="button" className="home-upload-btn">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                    Choose PDFs
                  </button>
                  <p className="home-upload-limit-note">
                    {SUPPORTED_LABEL} · Up to {formatSize(MAX_FILE_BYTES)} per file
                  </p>
                </div>

                {/* Uploaded Files List */}
                {files.length > 0 && (
                  <div className="home-files-list">
                    <div className="home-files-header">
                      <h4 className="home-files-title">Uploaded Files ({files.length})</h4>
                      <button type="button" className="home-clear-btn" onClick={clearAllFiles}>
                        Clear All
                      </button>
                    </div>

                    {files.map((f) => {
                      const pageRangeState = f.pageRange && showPageRangeInput(f) ? parsePageRange(f.pageRange, f.pages) : null;
                      const rangeErr = pageRangeState && !pageRangeState.ok ? pageRangeState.message : '';
                      const cost = getFileCost(f);

                      return (
                        <div key={f.key} className="home-file-card">
                          {/* File Header */}
                          <div className="home-file-header">
                            <div className="home-file-info">
                              <div className="home-file-icon-wrap" aria-hidden="true">
                                {isImageFile(f.file) ? '🖼️' : '📄'}
                              </div>
                              <div className="home-file-details">
                                <div className="home-file-name">{f.file.name}</div>
                                <div className="home-file-meta">
                                  <span>{formatSize(f.file.size)}</span>
                                  <span className="home-file-meta-sep">·</span>
                                  <span className="home-file-badge">
                                    {f.pages === null
                                      ? 'Detecting…'
                                      : `${f.pages} page${f.pages > 1 ? 's' : ''}${f.estimated ? ' (est)' : ''}`}
                                  </span>
                                </div>
                              </div>
                            </div>

                            {/* 44x44px Accessible Delete Button */}
                            <button
                              type="button"
                              className="home-file-remove-btn"
                              onClick={() => removeFile(f.key)}
                              aria-label={`Remove ${f.file.name}`}
                              title="Remove document"
                            >
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                <line x1="10" y1="11" x2="10" y2="17"></line>
                                <line x1="14" y1="11" x2="14" y2="17"></line>
                              </svg>
                            </button>
                          </div>

                          {/* Card Body */}
                          <div className="home-file-body">
                            {/* Copies Stepper */}
                            <div className="home-copies-row">
                              <span className="home-field-label">Number of Copies:</span>
                              <div className="home-stepper" role="group" aria-label="Copies">
                                <button
                                  type="button"
                                  className="home-stepper-btn"
                                  aria-label="Decrease copies"
                                  onClick={() => updateFileCopies(f.key, -1)}
                                >
                                  −
                                </button>
                                <span className="home-stepper-val" aria-live="polite">
                                  {f.copies ?? 1}
                                </span>
                                <button
                                  type="button"
                                  className="home-stepper-btn"
                                  aria-label="Increase copies"
                                  onClick={() => updateFileCopies(f.key, 1)}
                                >
                                  +
                                </button>
                              </div>
                            </div>

                            {/* Print Mode Group */}
                            <div className="home-setting-section">
                              <span className="home-setting-title">Print Mode</span>
                              <div className="home-options-grid" role="radiogroup" aria-label="Print Mode">
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={f.colorMode === 'bw'}
                                  className={`home-option-card ${f.colorMode === 'bw' ? 'is-selected' : ''}`}
                                  onClick={() => updateFileColorMode(f.key, 'bw')}
                                >
                                  <span className="home-radio-circle" aria-hidden="true">
                                    <span className="home-radio-dot" />
                                  </span>
                                  <div className="home-option-text">
                                    <span className="home-option-name">Black &amp; White</span>
                                    <span className="home-option-price">₹2/page</span>
                                  </div>
                                </button>
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={f.colorMode === 'color'}
                                  className={`home-option-card ${f.colorMode === 'color' ? 'is-selected' : ''}`}
                                  onClick={() => updateFileColorMode(f.key, 'color')}
                                >
                                  <span className="home-radio-circle" aria-hidden="true">
                                    <span className="home-radio-dot" />
                                  </span>
                                  <div className="home-option-text">
                                    <span className="home-option-name">Color</span>
                                    <span className="home-option-price">₹5/page</span>
                                  </div>
                                </button>
                              </div>
                            </div>

                            {/* Print Sides Group */}
                            <div className="home-setting-section">
                              <span className="home-setting-title">Print Sides</span>
                              <div className="home-options-grid" role="radiogroup" aria-label="Print Sides">
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={f.printingSide === 'single'}
                                  className={`home-option-card ${f.printingSide === 'single' ? 'is-selected' : ''}`}
                                  onClick={() => updateFilePrintingSide(f.key, 'single')}
                                >
                                  <span className="home-radio-circle" aria-hidden="true">
                                    <span className="home-radio-dot" />
                                  </span>
                                  <div className="home-option-text">
                                    <span className="home-option-name">Single Sided</span>
                                    <span className="home-option-price">₹2/page</span>
                                  </div>
                                </button>
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={f.printingSide === 'double'}
                                  className={`home-option-card ${f.printingSide === 'double' ? 'is-selected' : ''}`}
                                  onClick={() => updateFilePrintingSide(f.key, 'double')}
                                >
                                  <span className="home-radio-circle" aria-hidden="true">
                                    <span className="home-radio-dot" />
                                  </span>
                                  <div className="home-option-text">
                                    <span className="home-option-name">Double Sided</span>
                                    <span className="home-option-price">₹3/sheet</span>
                                  </div>
                                </button>
                              </div>
                            </div>

                            <div className="home-setting-section">
                              <span className="home-setting-title">Binding for this PDF</span>
                              <div className="home-options-grid" role="radiogroup" aria-label={`Binding for ${f.file.name}`}>
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={!f.spiralBinding}
                                  className={`home-option-card ${!f.spiralBinding ? 'is-selected' : ''}`}
                                  onClick={() => updateFileBinding(f.key, false)}
                                >
                                  <span className="home-radio-circle" aria-hidden="true"><span className="home-radio-dot" /></span>
                                  <span className="home-option-text">
                                    <span className="home-option-name">No</span>
                                    <span className="home-option-price">Free</span>
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  role="radio"
                                  aria-checked={!!f.spiralBinding}
                                  className={`home-option-card ${f.spiralBinding ? 'is-selected' : ''}`}
                                  onClick={() => updateFileBinding(f.key, true)}
                                  disabled={printablePages(f) < 5}
                                  title={printablePages(f) < 5 ? 'Available for 5 or more pages' : ''}
                                >
                                  <span className="home-radio-circle" aria-hidden="true"><span className="home-radio-dot" /></span>
                                  <span className="home-option-text">
                                    <span className="home-option-name">{printablePages(f) < 5 ? 'Unavailable' : 'Yes'}</span>
                                    <span className="home-option-price">{printablePages(f) < 5 ? 'Min 5 pages' : '₹26'}</span>
                                  </span>
                                </button>
                              </div>
                            </div>

                            {/* Page Range Input */}
                            {showPageRangeInput(f) && (
                              <div className="home-page-range-section">
                                <label htmlFor={`page-range-${f.key}`} className="home-setting-title">
                                  Pages to print (optional)
                                </label>
                                <div className="home-input-wrap">
                                  <input
                                    id={`page-range-${f.key}`}
                                    type="text"
                                    inputMode="numeric"
                                    className={`home-text-input ${rangeErr ? 'has-error' : ''}`}
                                    value={f.pageRange || ''}
                                    placeholder="e.g. 1-3, 5, 8-10"
                                    onChange={(e) => updateFilePageRange(f.key, e.target.value)}
                                    aria-invalid={!!rangeErr}
                                    aria-describedby={rangeErr ? `range-err-${f.key}` : `range-help-${f.key}`}
                                  />
                                </div>
                                <span id={`range-help-${f.key}`} className="home-help-text">
                                  Leave empty to print all {f.pages} pages.
                                </span>
                                {rangeErr && (
                                  <span id={`range-err-${f.key}`} role="alert" className="home-inline-error">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                      <circle cx="12" cy="12" r="10"></circle>
                                      <line x1="12" y1="8" x2="12" y2="12"></line>
                                      <line x1="12" y1="16" x2="12.01" y2="16"></line>
                                    </svg>
                                    {rangeErr}
                                  </span>
                                )}
                              </div>
                            )}

                            {/* Subtotal Footer */}
                            <div className="home-file-footer">
                              <span className="home-file-footer-pages">
                                {printablePages(f)} printable page{printablePages(f) !== 1 ? 's' : ''} × {f.copies} {f.copies > 1 ? 'copies' : 'copy'}
                              </span>
                              <span className="home-file-subtotal">
                                Doc Subtotal: <strong>₹{cost + (f.spiralBinding ? 26 : 0)}</strong>
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })}

                    <button
                      type="button"
                      className="home-add-more-btn"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                      </svg>
                      Add More PDFs
                    </button>
                  </div>
                )}

              {/* Pricing Summary Card */}
              <div className="pricing-total-wrap">
                <div className="pricing-total-card">
                  <div className="ptc-breakdown" id="pcBreakdown">
                    <span className="ptc-line"><span className="ptc-line-label">Total Pages</span><span className="ptc-line-val">{totalPages} pages</span></span>
                    <span className="ptc-line"><span className="ptc-line-label">Printing Charges</span><span className="ptc-line-val">₹{basePrice + a3Extra}</span></span>
                    {serviceCharge > 0 && (
                      <span className="ptc-line"><span className="ptc-line-label">Service Charge</span><span className="ptc-line-val">₹{serviceCharge}</span></span>
                    )}
                    {deliveryCharge > 0 && (
                      <span className="ptc-line"><span className="ptc-line-label">Classroom Delivery</span><span className="ptc-line-val">₹{deliveryCharge}</span></span>
                    )}
                    {bindingCharge > 0 && (
                      <span className="ptc-line"><span className="ptc-line-label">Binding</span><span className="ptc-line-val">₹{bindingCharge}</span></span>
                    )}
                  </div>

                  <div className="ptc-divider"></div>

                  <div className="ptc-total-row">
                    <span className="ptc-total-label">Estimated Total</span>
                    <span className={`ptc-total-amount${bump ? ' bump' : ''}`} id="pcTotalAmount">
                      ₹{total}
                    </span>
                  </div>

                  {isDetectingPages && (
                    <div className="home-status-alert is-info">
                      <span>⏳ Detecting page count for uploaded files…</span>
                    </div>
                  )}

                  {hasRangeErrors && (
                    <div className="home-status-alert is-warning">
                      <span>⚠️ Please fix invalid page ranges above to continue</span>
                    </div>
                  )}

                  <p className="ptc-note">
                    Final price calculated accurately per page. Copies and settings can be adjusted anytime before payment.
                  </p>

                  <button
                    className="btn btn-primary ptc-order-btn"
                    id="ptcOrderBtn"
                    disabled={!canOrder}
                    onClick={handleOrderClick}
                  >
                    {isDetectingPages ? 'Detecting Pages…' : (
                      <>
                        Start Your Order <span className="arrow-icon">→</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              </div>
            </section>
            <Footer />
          </main>
        </div>

       {/* Guest Details Modal for guest flow */}
      <GuestDetailsModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onSubmit={async (details) => {
          const guest = {
            fullName: details.fullName,
            email: details.email,
            phone: details.phone,
            classroom: details.classroom,
          };

          try {
            localStorage.setItem(
              'cp_guest_details',
              JSON.stringify(guest)
            );
          } catch {
            // localStorage unavailable
          }

          try {
            await persistHomeOrder(guest);
          } catch (err) {
            alert(storageErrorMessage(err));
          }

          setModalOpen(false);
          navigate('/new-order');
        }}
      />
    </>
  );
}
