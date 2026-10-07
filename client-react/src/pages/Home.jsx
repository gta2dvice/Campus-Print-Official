import { useEffect, useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import PageBackground from '../components/PageBackground';
import Footer from '../components/Footer';
import GuestDetailsModal from '../components/GuestDetailsModal';
import useDocumentTitle from '../lib/useDocumentTitle';
import {
  MAX_FILE_BYTES,
  MAX_ORDER_FILES,
  flushSaveCurrentOrder,
  loadCurrentOrder,
  saveCurrentOrder,
  scheduleSaveCurrentOrder,
  storageErrorMessage,
} from '../lib/orderStorage';
import '../styles/style.css';

const STUDENTS = [
  { name: 'Divye', branch: 'CSE Core', color: '59, 130, 246', review: 'Very fast printing and affordable pricing. Saved my semester submissions!' },
  { name: 'Kartike', branch: 'CSE AI-ML', color: '249, 115, 22', review: 'Upload system is smooth and no more long queues.' },
  { name: 'Ananya', branch: 'Mechanical', color: '20, 184, 166', review: 'Clean prints and very quick service inside campus.' },
  { name: 'Bhargavii', branch: 'BCA', color: '239, 68, 68', review: 'Very fast printing and affordable pricing. Saved my semester submissions!' },
  { name: 'Kush', branch: 'CSE Core', color: '139, 92, 246', review: 'Upload system is smooth and no more long queues.' },
  { name: 'Vartika', branch: 'CSE AI-ML', color: '56, 189, 248', review: 'Upload system is smooth and no more long queues.' },
];

const ALLOWED_TYPES = ['application/pdf'];

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
  const [config, setConfig] = useState(null);

  const [bump, setBump] = useState(false);
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
    try {
      const pendingPayment = JSON.parse(localStorage.getItem('cp_pending_payment') || 'null');
      if (pendingPayment?.cashfreeOrderId) {
        navigate(`/new-order?cf_order=${encodeURIComponent(pendingPayment.cashfreeOrderId)}`, { replace: true });
        return;
      }
      const ticketToken = localStorage.getItem('cp_last_ticket') || '';
      if (/^[a-f0-9]{64}$/i.test(ticketToken)) setLastTicketToken(ticketToken);
    } catch {
      localStorage.removeItem('cp_pending_payment');
    }
  }, [navigate]);

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
      if (!ALLOWED_TYPES.includes(file.type)) {
        alert(`${file.name}: only PDF files are allowed.`);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        alert(`${file.name}: files must be 20 MB or smaller.`);
        continue;
      }
      const clientPages = await countPdfPagesClient(file);
      accepted.push({
        key: Math.random(),
        file,
        pages: clientPages || null,
        estimated: false,
        copies: 1,
        printingSide: 'single',
        colorMode: 'bw'
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
  function updateFilePrintingSide(key, side) {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, printingSide: side } : f)));
  }

  function updateFileCopies(key, delta) {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, copies: Math.max(1, f.copies + delta) } : f)));
  }

  const totalPages = files.reduce((sum, f) => sum + ((f.pages || 1) * f.copies), 0);

  function calcPrice() {
    // Same rule as NewOrder.jsx / server: B&W double-sided is per physical sheet (2 pages per sheet).
    const printingSubtotal = files.reduce((sum, f) => {
      const pages = f?.pages || 1;
      const copies = f?.copies || 1;
      if (f?.colorMode === 'color') return sum + pages * copies * 5;
      if (f?.printingSide === 'double') return sum + Math.ceil(pages / 2) * copies * 3;
      return sum + pages * copies * 2;
    }, 0);

    const deliveryCharge = classroomDelivery ? 10 : 0;

    return {
      basePrice: printingSubtotal,
      a3Extra: 0,
      total: printingSubtotal + deliveryCharge
    };
  }

  const { basePrice, a3Extra, total } = calcPrice();

  useEffect(() => {
    async function loadConfig() {
      try {
        const res = await fetch('/api/orders/config', { credentials: 'include' });
        if (res.ok) setConfig(await res.json());
      } catch (err) {
        console.error('Failed to load config', err);
      }
    }
    loadConfig();
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const unfinished = await loadCurrentOrder();
      if (cancelled) return;
      if (unfinished) {
        extraMetaRef.current = {
          guestDetails: unfinished.guestDetails,
          spiralBinding: unfinished.spiralBinding,
          expressDelivery: unfinished.expressDelivery,
          selectedLocationId: unfinished.selectedLocationId,
          selectedLocationName: unfinished.selectedLocationName,
          selectedTimeSlot: unfinished.selectedTimeSlot,
          classroomDelivery: unfinished.classroomDelivery,
        };
        if (unfinished.files?.length) setFiles(unfinished.files);
        setSize(unfinished.paperSize);
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
      classroomDelivery,
    };
    extraMetaRef.current = meta;
    await saveCurrentOrder({
      meta,
      files: files.map(f => ({ ...f, printingSide: f.printingSide || printingSide }))
    });
  }

  async function handleOrderClick() {
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
              <a href="#location-section" className="nav-link" onClick={(e) => { e.preventDefault(); scrollToId('location-section'); }}>Location</a>
            </nav>
          </header>

          <div className="hero-content" id="heroText" ref={heroTextRef}>
            <h1 className="hero-title">CAMPUS PRINTS</h1>
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
            {lastTicketToken && (
              <p>
                <Link className="btn btn-secondary" to={`/ticket?token=${encodeURIComponent(lastTicketToken)}`}>
                  Recover your last ticket
                </Link>
              </p>
            )}
          </div>

          <div className="scroll-arrow" id="scrollArrow" onClick={() => scrollToId('main-content')}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 13l5 5 5-5M7 6l5 5 5-5" />
            </svg>
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
                      <p>1. Main Gate<br />2. Academic Block<br />3. Hostel Gate</p>
                    </div>
                  </div>
                  <div className="location-detail-item">
                    <span className="detail-icon">🕐</span>
                    <div>
                      <strong>Hours</strong>
                      <p>Mon –Fri: 9:00 AM – 4:00 PM<br />Sunday &amp; Saturday: Closed(Online Services)</p>
                    </div>
                  </div>
                  <div className="location-detail-item">
                    <span className="detail-icon">📞</span>
                    <div>
                      <strong>Contact</strong>
                      <p>+91 9457311377<br />kartikedivye@gmail.com</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="location-map-card">
                <div className="map-placeholder">
                  <div className="map-pin-anim">
                    <div className="map-pin">
                      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 21s-8-7.5-8-12a8 8 0 1 1 16 0c0 4.5-8 12-8 12z" />
                        <circle cx="12" cy="9" r="2.5" fill="#3b82f6" stroke="none" />
                      </svg>
                    </div>
                    <div className="pin-pulse"></div>
                  </div>
                  <p className="map-label">Print Campus<br /><span>Main Academic Block</span></p>
                  <a href="https://maps.app.goo.gl/5xF6EL14PGSuvids6" target="_blank" rel="noreferrer" className="btn btn-primary map-btn">
                    Open in Maps →
                  </a>
                </div>
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

              <div className="pricing-cards-row" style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: '1.5rem',
                width: '100%',
                maxWidth: '800px',
                margin: '0 auto'
              }}>
                <div className="pricing-card" id="pcColorCard" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div className="pc-icon">🖨️</div>
                  <h3 className="pc-title">Color Mode</h3>
                  <div className="pc-info-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: 'auto', paddingBottom: '0.5rem' }}>
                    <div className="pc-info-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                      <span>B&amp;W</span>
                      <span className="pc-info-price" style={{ fontWeight: '600' }}>₹2 / page</span>
                    </div>
                    <div className="pc-info-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                      <span>Color</span>
                      <span className="pc-info-price" style={{ fontWeight: '600' }}>₹5 / page</span>
                    </div>
                  </div>
                </div>

                <div className="pricing-card" id="pcSizeCard" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div className="pc-icon">📄</div>
                  <h3 className="pc-title">Paper Size</h3>
                  <div className="pc-info-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: 'auto', paddingBottom: '0.5rem' }}>
                    <div className="pc-info-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                      <span>A4</span>
                      <span className="pc-info-price" style={{ fontWeight: '600' }}>Standard</span>
                    </div>
                  </div>
                </div>

                <div className="pricing-card" id="pcSideCard" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div className="pc-icon">↕️</div>
                  <h3 className="pc-title">Printing Side</h3>
                  <div className="pc-info-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: 'auto', paddingBottom: '0.5rem' }}>
                    <div className="pc-info-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                      <span>Single</span>
                      <span className="pc-info-price" style={{ fontWeight: '600' }}>One Side</span>
                    </div>
                    <div className="pc-info-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                      <span>Double</span>
                      <span className="pc-info-price" style={{ fontWeight: '600' }}>Both Sides</span>
                    </div>
                  </div>
                </div>

                <div className="pricing-card" id="pcDeliveryCard" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <div className="pc-icon">🚚</div>
                  <h3 className="pc-title">Classroom Delivery</h3>
                  <div className="pc-info-list" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: 'auto', paddingBottom: '0.5rem' }}>
                    <div className="pc-info-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                      <span>No</span>
                      <span className="pc-info-price" style={{ fontWeight: '600' }}>Free</span>
                    </div>
                    <div className="pc-info-row" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.95rem', color: 'var(--text-primary)' }}>
                      <span>Yes</span>
                      <span className="pc-info-price" style={{ fontWeight: '600' }}>₹10</span>
                    </div>
                  </div>
                </div>
              </div>

                                                                              <div className="upload-interactive-section" style={{ marginTop: '2.5rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem' }}>
                  <div className="delivery-toggle-wrap" style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '1rem',
                    padding: '0.75rem 1.5rem',
                    background: 'white',
                    borderRadius: '2rem',
                    boxShadow: '0 2px 10px rgba(0,0,0,0.05)',
                    border: '1px solid #eee',
                    marginBottom: '0.5rem'
                  }}>
                    <span style={{ fontSize: '0.9rem', fontWeight: '500', color: '#666' }}>Classroom Delivery:</span>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        className={`btn btn-sm ${!classroomDelivery ? 'btn-primary' : 'btn-outline'}`}
                        onClick={() => setClassroomDelivery(false)}
                        style={{ fontSize: '0.8rem', padding: '0.25rem 0.75rem' }}
                      >
                        No (Free)
                      </button>
                      <button
                        className={`btn btn-sm ${classroomDelivery ? 'btn-primary' : 'btn-outline'}`}
                        onClick={() => setClassroomDelivery(true)}
                        style={{ fontSize: '0.8rem', padding: '0.25rem 0.75rem' }}
                      >
                        Yes (+₹10)
                      </button>
                    </div>
                  </div><div className="upload-zone-home"
                     style={{
                       width: '100%',
                       maxWidth: '600px',
                       border: '2px dashed var(--primary-blue, #3b82f6)',
                       borderRadius: '1rem',
                       padding: '2rem',
                       textAlign: 'center',
                       cursor: 'pointer',
                       background: 'rgba(59, 130, 246, 0.05)',
                       transition: 'all 0.2s ease'
                     }}
                     onClick={() => fileInputRef.current?.click()}
                     onDragOver={(e) => { e.preventDefault(); }}
                     onDrop={(e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept=".pdf"
                    style={{ display: 'none' }}
                    onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }}
                  />
                  <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📄</div>
                  <h3 style={{ fontSize: '1.2rem', margin: '0 0 0.5rem 0' }}>Upload Your PDFs</h3>
                  <p style={{ color: '#666', fontSize: '0.9rem', marginBottom: '1rem' }}>Drag &amp; drop your PDF files here or click to browse</p>
                  <button className="btn btn-secondary" style={{ fontSize: '0.85rem' }}>+ Choose PDF Files</button>
                  <p style={{ fontSize: '0.8rem', color: '#888', marginTop: '0.5rem' }}>You can upload multiple PDFs</p>
                </div>

                {files.length > 0 && (
                  <div className="home-files-list" style={{ width: '100%', maxWidth: '600px', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <h4 style={{ fontSize: '1rem', fontWeight: '600' }}>Uploaded Files ({files.length})</h4>
                      <button onClick={clearAllFiles} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '0.85rem', fontWeight: '500' }}>Clear All</button>
                    </div>
                    {files.map((f) => (
                      <div key={f.key} style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '1rem',
                        background: 'white',
                        borderRadius: '0.75rem',
                        boxShadow: '0 2px 5px rgba(0,0,0,0.05)',
                        border: '1px solid #eee',
                        gap: '1rem',
                        flexDirection: 'column',
                        alignItems: 'stretch'
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flex: 1 }}>
                            <span style={{ fontSize: '1.2rem' }}>📄</span>
                            <div>
                              <div style={{ fontWeight: '600', fontSize: '0.9rem' }}>{f.file.name}</div>
                              <div style={{ fontSize: '0.8rem', color: '#666' }}>{formatSize(f.file.size)} · {f.pages === null ? 'Detecting...' : `${f.pages} pages`}</div>
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                            <div className="counter" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: '#f3f4f6', padding: '0.25rem', borderRadius: '0.5rem' }}>
                              <button className="counter-btn" style={{ width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'white', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer' }} onClick={() => updateFileCopies(f.key, -1)}>−</button>
                              <span style={{ minWidth: '1.5rem', textAlign: 'center', fontSize: '0.9rem', fontWeight: '600' }}>{f.copies}</span>
                              <button className="counter-btn" style={{ width: '24px', height: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'white', border: '1px solid #ddd', borderRadius: '4px', cursor: 'pointer' }} onClick={() => updateFileCopies(f.key, 1)}>+</button>
                            </div>
                            <button onClick={() => removeFile(f.key)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontSize: '1.2rem' }}>✕</button>
                          </div>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                            <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#666' }}>Color Mode</span>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                              <button
                                className={`btn btn-sm ${f.colorMode === 'bw' ? 'btn-primary' : 'btn-outline'}`}
                                onClick={() => updateFileColorMode(f.key, 'bw')}
                                style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                              >
                                B&amp;W (₹2/pg)
                              </button>
                              <button
                                className={`btn btn-sm ${f.colorMode === 'color' ? 'btn-primary' : 'btn-outline'}`}
                                onClick={() => updateFileColorMode(f.key, 'color')}
                                style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                              >
                                Color (₹5/pg)
                              </button>
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                            <span style={{ fontSize: '0.8rem', fontWeight: '600', color: '#666' }}>Printing Side</span>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                              <button
                                className={`btn btn-sm ${f.printingSide === 'single' ? 'btn-primary' : 'btn-outline'}`}
                                onClick={() => updateFilePrintingSide(f.key, 'single')}
                                style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                              >
                                Single Side (₹2/pg)
                              </button>
                              <button
                                className={`btn btn-sm ${f.printingSide === 'double' ? 'btn-primary' : 'btn-outline'}`}
                                onClick={() => updateFilePrintingSide(f.key, 'double')}
                                style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                              >
                                Both Sides (₹3/pg)
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                    <button className="btn btn-secondary" style={{ width: 'fit-content', alignHelf: 'center', fontSize: '0.85rem' }} onClick={() => fileInputRef.current?.click()}>+ Add More PDFs</button>
                  </div>
                )}
              </div>

              <div className="pricing-total-wrap">
                <div className="pricing-total-card">
                  <div className="ptc-breakdown" id="pcBreakdown">
                    <span className="ptc-line"><span className="ptc-line-label">Total Pages</span><span className="ptc-line-val">{totalPages} pages</span></span>
                    <span className="ptc-line"><span className="ptc-line-label">Printing Charges</span><span className="ptc-line-val">₹{basePrice + a3Extra}</span></span>
                    {classroomDelivery && (
                      <span className="ptc-line"><span className="ptc-line-label">Classroom Delivery</span><span className="ptc-line-val">₹10</span></span>
                    )}
                  </div>
                  <div className="ptc-divider"></div>
                  <div className="ptc-total-row">
                    <span className="ptc-total-label">Estimated Total</span>
                    <span className={`ptc-total-amount${bump ? ' bump' : ''}`} id="pcTotalAmount">₹{total}</span>
                  </div>
                  <p className="ptc-note">Final price calculated per page after upload. Copies can be set in the order form.</p>
                  <button className="btn btn-primary ptc-order-btn" id="ptcOrderBtn" disabled={files.length === 0} onClick={handleOrderClick}>
                    Start Your Order <span className="arrow-icon">→</span>
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
            phone: details.phone,
            classroom: details.classroom,
          };
          try {
            localStorage.setItem('cp_guest_details', JSON.stringify(guest));
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
