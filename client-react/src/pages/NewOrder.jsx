import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DashboardSidebar from '../components/DashboardSidebar';
import Toast from '../components/Toast';
import useToast from '../lib/useToast';
import useBodyClass from '../lib/useBodyClass';
import useDocumentTitle from '../lib/useDocumentTitle';
import {
  MAX_FILE_BYTES,
  MAX_ORDER_FILES,
  clearCompletedOrder,
  flushSaveCurrentOrder,
  loadCurrentOrder,
  removeCurrentOrder,
  saveCurrentOrder,
  storageErrorMessage,
} from '../lib/orderStorage';
import { SLOT_LOCATIONS, TIME_SLOTS, isLocationOffered } from '../lib/slotAvailability';
import '../styles/style.css';
import '../styles/dashboard.css';

const ALLOWED_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
];
const ALLOWED_EXTENSIONS = /\.(pdf|docx|doc|png|jpg|jpeg|webp)$/i;

function isFileSupported(file) {
  if (!file) return false;
  if (file.type && ALLOWED_TYPES.includes(file.type.toLowerCase())) return true;
  if (file.name && ALLOWED_EXTENSIONS.test(file.name)) return true;
  return false;
}
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

// Booking step 3. 'whatsapp' (shown as QR Payment) and 'none' are settled outside the app (POST /api/orders/payment/offline).
const PAYMENT_OPTIONS = [
  {
    id: 'cashfree',
    name: 'Cashfree Payment',
    sub: 'Pay online now with UPI, card or netbanking',
    icon: <><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></>,
  },
  {
    id: 'whatsapp',
    name: 'QR Payment',
    sub: 'Scan the shop QR with any UPI app',
    icon: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></>,
  },
  {
    id: 'none',
    name: 'No Payment',
    sub: 'Contact the shop for payment instructions',
    icon: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z" />,
  },
];
const SLOT_CUTOFF_MINUTES = 5;
const LIVE_SLOT_AVAILABILITY = true;
// 5:00 PM IST — once reached, same-day booking is closed and tomorrow opens for pre-order.
const NEXT_DAY_SWITCH_MINUTES = 17 * 60;

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

// This is only the offline fallback used when /api/orders/slots can't be reached —
// the server (server/slots.js) is the source of truth whenever it's reachable.
function isPreOrderModeFallback() {
  if (!LIVE_SLOT_AVAILABILITY) return false;
  return nowMinutesIST() >= NEXT_DAY_SWITCH_MINUTES;
}

function isSlotPast(time) {
  if (!LIVE_SLOT_AVAILABILITY) return false;
  if (isPreOrderModeFallback()) return false; // tomorrow's slots are never "past" today
  return nowMinutesIST() >= slotMinutes(time) - SLOT_CUTOFF_MINUTES;
}

// Printing cost for one file. B&W double-sided is charged per physical sheet
// (2 PDF pages per sheet, rounded up per copy); B&W single-sided and colour stay per page.
// Keep in sync with filePrintingCost() in server/routes/orders.js, which verifies the total.
function filePrintingCost(f) {
  const pages = f?.pages || 1;
  const copies = f?.copies || 1;
  if (f?.colorMode === 'color') return pages * copies * 5;
  if (f?.printingSide === 'double') return Math.ceil(pages / 2) * copies * 3;
  return pages * copies * 2;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

let fileKeySeq = 0;

export default function NewOrder() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const returnedCashfreeOrderId = searchParams.get('cf_order') || searchParams.get('order_id');
  useBodyClass('app-body');
  useDocumentTitle('New Order – Print Campus');
  const { toast, showToast } = useToast();

  const [currentUser, setCurrentUser] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [guestDetails, setGuestDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null);

  // ── Order configuration state ──
  const [files, setFiles] = useState([]); // [{ key, file, pages, estimated, copies, printingSide, colorMode }]
  const [paperSize, setPaperSize] = useState('A4');
  const [spiralBinding, setSpiralBinding] = useState(false);
  const [expressDelivery, setExpressDelivery] = useState(false);
  const [classroomDelivery, setClassroomDelivery] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // ── Booking modal state ──
  const [modalOpen, setModalOpen] = useState(false);
  const [step, setStep] = useState('slot'); // 'slot' | 'location' | 'payment' | 'review'
  const [preOrderMode, setPreOrderMode] = useState(false); // true once same-day booking closed (after 5 PM IST) — slots shown are tomorrow's
  const [selectedLocationId, setSelectedLocationId] = useState(null);
  const [selectedLocationName, setSelectedLocationName] = useState(null);
  const [selectedTimeSlot, setSelectedTimeSlot] = useState(null);
  const [slots, setSlots] = useState([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [locationStatuses, setLocationStatuses] = useState([]);
  const [paymentMethod, setPaymentMethod] = useState(null); // 'cashfree' | 'whatsapp' | 'none'
  const [paymentOptions, setPaymentOptions] = useState(null); // { phone, hasQr, qrVersion } from /api/orders/payment-options
  const [paymentOptionsLoading, setPaymentOptionsLoading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState('');
  const [recoveryOrderId, setRecoveryOrderId] = useState(returnedCashfreeOrderId || '');
  const persistReadyRef = useRef(false);
  const handledReturnOrderRef = useRef(null);
  const confirmPaidOrderRef = useRef(null);
  const recoverPaymentRef = useRef(null);
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const unfinished = await loadCurrentOrder();
        if (cancelled) return;

        let savedPayment = null;
        try {
          savedPayment = JSON.parse(localStorage.getItem('cp_pending_payment') || 'null');
        } catch {
          savedPayment = null;
        }
        const pendingCashfreeOrderId = returnedCashfreeOrderId || savedPayment?.cashfreeOrderId || '';
        if (pendingCashfreeOrderId) setRecoveryOrderId(pendingCashfreeOrderId);

        if (unfinished) {
          if (unfinished.files?.length) {
            const restoredKeys = unfinished.files.map((entry) => Number(entry.key)).filter((n) => Number.isFinite(n));
            if (restoredKeys.length) fileKeySeq = Math.max(fileKeySeq, ...restoredKeys);
            setFiles(unfinished.files);
          }
          setPaperSize(unfinished.paperSize);
          setSpiralBinding(unfinished.spiralBinding);
          setExpressDelivery(unfinished.expressDelivery);
          setClassroomDelivery(unfinished.classroomDelivery || false);
          // A saved pairing may no longer exist in the slot matrix — keep the time, drop the location.
          const savedPairValid = !unfinished.selectedLocationId || !unfinished.selectedTimeSlot
            || isLocationOffered(unfinished.selectedLocationId, unfinished.selectedTimeSlot);
          setSelectedLocationId(savedPairValid ? unfinished.selectedLocationId : null);
          setSelectedLocationName(savedPairValid ? unfinished.selectedLocationName : null);
          setSelectedTimeSlot(unfinished.selectedTimeSlot);
        }

        // 1. Load Guest Details from localStorage (or unfinished order)
        let savedGuest = JSON.parse(localStorage.getItem('cp_guest_details') || 'null');
        if (!savedGuest && unfinished?.guestDetails) {
          savedGuest = unfinished.guestDetails;
          try {
            localStorage.setItem('cp_guest_details', JSON.stringify(savedGuest));
          } catch {
            // localStorage unavailable
          }
        }
        if (savedGuest) {
          setGuestDetails(savedGuest);
          setDisplayName(savedGuest.fullName || savedGuest.name);
        }

        try {
          const pending = JSON.parse(localStorage.getItem('cp_pending_order') || 'null');
          if (pending) {
            if (pending.color === 'bw' || pending.color === 'color') setColorOption(pending.color);
            if (pending.size === 'A4' || pending.size === 'A3') setPaperSize(pending.size);
            setSpiralBinding(!!pending.spiral);
            setExpressDelivery(!!pending.express);
            localStorage.removeItem('cp_pending_order');
          }
        } catch {
          // ignore malformed/unavailable localStorage data
        }

        // 2. Load Auth Status (keep for Admin/SuperAdmin if applicable, but students are guest now)
        const res = await fetch('/api/auth/status', { credentials: 'include' });
        const data = await res.json();

        if (!data.isLoggedIn && !savedGuest && !pendingCashfreeOrderId) {
          navigate('/');
          return;
        }

        if (cancelled) return;
        setCurrentUser(data);
        if (data.isLoggedIn && !savedGuest) {
          const name = (data.email || '').split('@')[0];
          setDisplayName(name.charAt(0).toUpperCase() + name.slice(1));
        }

        const configRes = await fetch('/api/orders/config', { credentials: 'include' });
        if (configRes.ok) setConfig(await configRes.json());
      } catch {
        if (!localStorage.getItem('cp_guest_details') && !returnedCashfreeOrderId &&
            !localStorage.getItem('cp_pending_payment')) {
          navigate('/');
        }
        return;
      }
      if (!cancelled) {
        persistReadyRef.current = true;
        setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
      persistReadyRef.current = false;
      flushSaveCurrentOrder().catch(() => {});
    };
  }, [navigate, returnedCashfreeOrderId]);

  useEffect(() => {
    // Temporarily disabled to diagnose runtime crash
    // if (!persistReadyRef.current) return;
    // if (skipPersistRef.current) {
    //   skipPersistRef.current = false;
    //   return;
    // }
    // scheduleSaveCurrentOrder({
    //   meta: {
    //     guestDetails,
    //     paperSize,
    //     spiralBinding,
    //     expressDelivery,
    //     classroomDelivery,
    //     selectedLocationId,
    //     selectedLocationName,
    //     selectedTimeSlot,
    //   },
    //   files,
    //   onError: (err) => {
    //     if (typeof showToast === 'function') {
    //       showToast(storageErrorMessage(err), 'error');
    //     } else if (showToastRef.current) {
    //       showToastRef.current(storageErrorMessage(err), 'error');
    //     }
    //   },
    // });
  }, [
    guestDetails,
    files,
    paperSize,
    spiralBinding,
    expressDelivery,
    classroomDelivery,
    selectedLocationId,
    selectedLocationName,
    selectedTimeSlot,
  ]);

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
        showToast('Max 10 files allowed.', 'error');
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        showToast(`${file.name}: files must be 20 MB or smaller.`, 'error');
        continue;
      }
      if (!isFileSupported(file)) {
        showToast(`${file.name}: unsupported type. Supported: PDF, DOCX, DOC, PNG, JPG.`, 'error');
        continue;
      }
      let clientPages = null;
      if (file.type?.startsWith('image/') || /\.(png|jpg|jpeg|webp)$/i.test(file.name)) {
        clientPages = 1;
      } else {
        clientPages = await countPdfPagesClient(file);
      }
      accepted.push({
        key: ++fileKeySeq,
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);

    try {
      const res = await fetch('/api/orders/detect-pages', {
        method: 'POST', credentials: 'include', body: formData, signal: controller.signal
      });
      if (!res.ok) throw new Error('detect-pages failed');
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
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function updateFilePages(key, val) {
    const pages = Math.max(1, parseInt(val, 10) || 1);
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, pages, estimated: false } : f)));
  }

  function removeFile(key) {
    setFiles((prev) => prev.filter((f) => f.key !== key));
  }

  function updateFilePrintingSide(key, side) {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, printingSide: side } : f)));
  }

  function updateFileColorMode(key, mode) {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, colorMode: mode } : f)));
  }

  function updateFileCopies(key, delta) {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, copies: Math.max(1, f.copies + delta) } : f)));
  }

  function clearAllFiles() {
    if (files.length === 0) return;
    if (!window.confirm('Clear this unfinished order? Uploaded files and saved selections will be removed from this browser.')) {
      return;
    }
    skipPersistRef.current = true;
    setFiles([]);
    setPaperSize('A4');
    setSpiralBinding(false);
    setExpressDelivery(false);
    setSelectedLocationId(null);
    setSelectedLocationName(null);
    setSelectedTimeSlot(null);
    removeCurrentOrder().catch((err) => showToast(storageErrorMessage(err), 'error'));
  }

  async function finishSuccessfulOrder(ticketToken) {
    if (!ticketToken) {
      showToast('Payment was verified, but the server did not return a secure ticket link.', 'error');
      setPaying(false);
      return;
    }
    try {
      localStorage.setItem('cp_last_ticket', ticketToken);
      localStorage.removeItem('cp_pending_payment');
    } catch {
      // The secure ticket link remains available in the current response.
    }
    try {
      await clearCompletedOrder();
    } catch {
      // Server order already succeeded; clearing the local draft is best-effort.
    }
    closeBookingModal();
    console.info('[NAVIGATION] Opening secure ticket.');
    navigate(`/ticket?token=${encodeURIComponent(ticketToken)}`);
  }

  const totalPagesCount = files.reduce((sum, f) => sum + ((f.pages || 1) * f.copies), 0);
  const pagesStillDetecting = files.some((f) => f.pages === null);

  function calcPrice() {
    if (!config) return { pages: 0, base: 0, a3Extra: 0, serviceCharge: 0, deliveryCharge: 0, total: 0 };

    const printingSubtotal = files.reduce((sum, f) => sum + filePrintingCost(f), 0);

    const serviceCharge = 3;
    let deliveryCharge = 0;
    if (selectedLocationId === 'hostel-gate') {
      deliveryCharge = 4;
    } else if (classroomDelivery) {
      deliveryCharge = 10;
    }

    return {
      pages: totalPagesCount || 0,
      base: printingSubtotal || 0,
      a3Extra: 0,
      serviceCharge,
      deliveryCharge,
      total: (printingSubtotal || 0) + serviceCharge + deliveryCharge
    };
  }

  const p = calcPrice();
  const hasFiles = files.length > 0;
  const filesMissingSettings = files.some(f => !f.printingSide || !f.colorMode);

  function openBookingModal() {
    if (!hasFiles) { showToast('Please upload at least one file to continue.', 'error'); return; }
    if (pagesStillDetecting) { showToast('Still detecting page count — please wait a moment.', 'error'); return; }
    setModalOpen(true);
    goToStep('slot');
  }

  function closeBookingModal() {
    setModalOpen(false);
  }

  useEffect(() => {
    if (!modalOpen) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [modalOpen]);

  useEffect(() => {
    if (!modalOpen) return;
    function onKey(e) { if (e.key === 'Escape') closeBookingModal(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modalOpen]);

  function goToStep(nextStep) {
    setStep(nextStep);
    if (nextStep === 'slot') loadTimeSlots();
    if (nextStep === 'location') loadLocationOptions();
    if (nextStep === 'payment') loadPaymentOptions();
  }

  async function loadPaymentOptions() {
    setPaymentOptionsLoading(true);
    let options = { phone: null, hasQr: false, qrVersion: null };
    try {
      const res = await fetch('/api/orders/payment-options', { credentials: 'include' });
      if (res.ok) options = await res.json();
    } catch {
      // Cashfree and "No Payment" still work without these details.
    }
    setPaymentOptions(options);
    // The shop may have removed its QR since it was picked.
    setPaymentMethod((m) => (m === 'whatsapp' && !options.hasQr ? null : m));
    setPaymentOptionsLoading(false);
  }

  function selectTimeSlot(time) {
    setSelectedTimeSlot(time);
    if (selectedLocationId && !isLocationOffered(selectedLocationId, time)) {
      setSelectedLocationId(null);
      setSelectedLocationName(null);
    }
  }

  async function loadTimeSlots() {
    setSlotsLoading(true);
    let slotsData = [];
    let preOrder = false;
    try {
      const res = await fetch('/api/orders/slots', { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        slotsData = data.slots || [];
        preOrder = !!data.preOrder;
      } else {
        showToast('Could not load available slots.', 'error');
      }
    } catch {
      // fall through to local cutoff
    }
    if (!slotsData.length) {
      preOrder = isPreOrderModeFallback();
      slotsData = TIME_SLOTS.map((time) => ({
        time,
        status: isSlotPast(time) ? 'past' : 'available',
      }));
    }
    setPreOrderMode(preOrder);
    setSlots(slotsData);
    setSlotsLoading(false);
  }

  async function loadLocationOptions() {
    if (!selectedTimeSlot) {
      setLocationStatuses(LOCATIONS.map((loc) => ({ id: loc.id, status: 'unavailable' })));
      return;
    }
    setSlotsLoading(true);
    let locationsData = [];
    try {
      const res = await fetch(`/api/orders/slots?time=${encodeURIComponent(selectedTimeSlot)}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        locationsData = data.locations || [];
      }
    } catch {
      // fall through
    }
    if (!locationsData.length) {
      const past = isSlotPast(selectedTimeSlot);
      locationsData = LOCATIONS.map((loc) => {
        const offered = isLocationOffered(loc.id, selectedTimeSlot);
        if (!offered) return { id: loc.id, status: 'unavailable' };
        if (past) return { id: loc.id, status: 'past' };
        return { id: loc.id, status: 'available' };
      });
    }
    setLocationStatuses(locationsData);
    setSlotsLoading(false);
  }

  function handleLocationSelect(locId, locName) {
    if (selectedTimeSlot && !isLocationOffered(locId, selectedTimeSlot)) return;
    setSelectedLocationId(locId);
    setSelectedLocationName(locName);

    if (locId === 'academic-block') {
      // Trigger confirmation for classroom delivery
      const wantsDelivery = window.confirm('Do you want Classroom Delivery for an additional ₹10?');
      setClassroomDelivery(wantsDelivery);
    } else {
      // Automatically disable for other locations
      setClassroomDelivery(false);
    }
  }

  function buildOrderFormData() {
    const formData = new FormData();
    formData.append('paperSize', paperSize);
    formData.append('totalPages', p.pages);
    const totalCopies = files.reduce((sum, f) => sum + f.copies, 0);
    formData.append('copies', totalCopies);
    formData.append('spiralBinding', spiralBinding);
    formData.append('expressDelivery', expressDelivery);
    formData.append('classroomDelivery', classroomDelivery);
    formData.append('totalPrice', p.total);
    formData.append('collectionLocationId', selectedLocationId);
    formData.append('collectionLocation', selectedLocationName);
    formData.append('collectionTime', selectedTimeSlot);

    // Guest Details
    formData.append('fullName', guestDetails?.fullName || '');
    formData.append('phone', guestDetails?.phone || '');
    formData.append('classroom', guestDetails?.classroom || '');

    // Per-file settings for backend verification and storage
    const fileSettings = files.map(f => ({
      key: f.key,
      pages: f.pages,
      copies: f.copies,
      printingSide: f.printingSide,
      colorMode: f.colorMode || 'bw'
    }));
    formData.append('fileSettings', JSON.stringify(fileSettings));

    files.forEach((f) => formData.append('files', f.file));
    return formData;
  }

  async function placeOfflineOrder(method) {
    try {
      const formData = buildOrderFormData();
      formData.append('paymentMethod', method);
      const response = await fetch('/api/orders/payment/offline', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showToast(data.message || 'Failed to place order.', 'error');
        setPaying(false);
        return;
      }
      await finishSuccessfulOrder(data.ticketToken);
    } catch {
      showToast('Connection error. Please try again.', 'error');
      setPaying(false);
    }
  }

  async function confirmPaidOrder(cashfreeOrderId) {
    console.info('[PAYMENT_VERIFY] Verification request started:', { cashfreeOrderId });
    const verifyRes = await fetch('/api/orders/payment/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ cashfree_order_id: cashfreeOrderId })
    });
    const verifyData = await verifyRes.json().catch(() => ({}));
    if (verifyData.status === 'PAID' && verifyData.ticketToken) {
      console.info('[PAYMENT_VERIFY] Backend returned created ticket:', {
        ticketNumberPresent: Boolean(verifyData.ticketNumber)
      });
      await finishSuccessfulOrder(verifyData.ticketToken);
      return 'PAID';
    }
    if (verifyData.status === 'PAYMENT_FAILED') {
      try {
        localStorage.removeItem('cp_pending_payment');
      } catch {
        // A failed payment has no ticket, even if browser storage is unavailable.
      }
      setPaymentMessage('Cashfree could not complete this payment. No ticket was generated.');
      setPaying(false);
      return 'PAYMENT_FAILED';
    }
    if (verifyData.status === 'PAYMENT_PENDING') {
      setPaymentMessage('Payment confirmation pending. We are checking Cashfree and preparing your ticket.');
      return 'PAYMENT_PENDING';
    }
    console.error('[PAYMENT_VERIFY_FAILED]', {
      stage: 'verification_response',
      cashfreeOrderId,
      httpStatus: verifyRes.status,
      code: verifyData.code || 'PAYMENT_VERIFICATION_FAILED'
    });
    throw new Error(verifyData.message || 'Payment verification could not reach the server.');
  }
  confirmPaidOrderRef.current = confirmPaidOrder;

  async function recoverPayment(cashfreeOrderId) {
    if (!cashfreeOrderId) return;
    setPaying(true);
    setPaymentMessage('Checking payment status with Cashfree…');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const status = await confirmPaidOrderRef.current(cashfreeOrderId);
        if (status === 'PAID' || status === 'PAYMENT_FAILED') return;
      } catch (error) {
        setPaymentMessage('Payment confirmation pending. Check your connection and retry; do not pay again.');
        console.warn('[PAYMENT_VERIFY_RETRY]', {
          cashfreeOrderId,
          attempt: attempt + 1,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        });
      }
      if (attempt < 19) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    setPaymentMessage('Payment confirmation is still pending. You can safely close this page and retry later.');
    setPaying(false);
  }
  recoverPaymentRef.current = recoverPayment;

  useEffect(() => {
    if (loading || !recoveryOrderId || handledReturnOrderRef.current === recoveryOrderId) return;
    handledReturnOrderRef.current = recoveryOrderId;
    console.info('[PAYMENT_RETURN] Cashfree return received:', {
      cashfreeOrderId: recoveryOrderId
    });
    recoverPaymentRef.current(recoveryOrderId).catch((error) => {
      console.error('[PAYMENT_RETURN_FAILED]', {
        stage: 'verification_request',
        cashfreeOrderId: recoveryOrderId,
        errorName: error instanceof Error ? error.name : 'UnknownError'
      });
      setPaymentMessage('Payment confirmation pending. Retry when your connection is available.');
      setPaying(false);
    });
  }, [loading, recoveryOrderId]);

  async function handlePay() {
    if (!selectedLocationId || !selectedTimeSlot) {
      showToast('Please select a collection location and time slot.', 'error');
      return;
    }
    if (!hasFiles) { showToast('Please upload at least one file to continue.', 'error'); return; }
    if (filesMissingSettings) { showToast('Please choose printing settings for all files.', 'error'); return; }

    // Location-based classroom validation
    const needsClassroom = ['main-gate', 'academic-block', 'classroom-delivery'].includes(selectedLocationId) || classroomDelivery;
    if ((needsClassroom || classroomDelivery) && (!guestDetails?.classroom || !guestDetails.classroom.trim())) {
      showToast('Please enter your classroom/room number.', 'error');
      return;
    }

    if (!paymentMethod) {
      showToast('Please choose a payment option.', 'error');
      goToStep('payment');
      return;
    }

    setPaying(true);

    if (paymentMethod !== 'cashfree') {
      await placeOfflineOrder(paymentMethod);
      return;
    }

    try {
      try {
        await saveCurrentOrder({
          meta: {
            guestDetails,
            paperSize,
            spiralBinding,
            expressDelivery,
            classroomDelivery,
            selectedLocationId,
            selectedLocationName,
            selectedTimeSlot,
          },
          files,
        });
      } catch (error) {
        showToast(storageErrorMessage(error), 'error');
        setPaying(false);
        return;
      }

      const createRes = await fetch('/api/orders/payment/create', {
        method: 'POST',
        credentials: 'include',
        body: buildOrderFormData(),
      });

      const createData = await createRes.json().catch(() => ({}));
      if (!createRes.ok) {
        const code = createData.code ? ` (${createData.code})` : '';
        showToast(`${createData.message || 'Could not start payment session.'}${code}`, 'error');
        setPaying(false);
        return;
      }

      if (!createData.paymentSessionId || !createData.cashfreeOrderId) {
        showToast('The payment service returned an incomplete session. Please try again.', 'error');
        setPaying(false);
        return;
      }
      localStorage.setItem('cp_pending_payment', JSON.stringify({
        cashfreeOrderId: createData.cashfreeOrderId,
        createdAt: Date.now()
      }));
      setRecoveryOrderId(createData.cashfreeOrderId);
      setPaymentMessage('Complete payment in Cashfree. Your ticket will be created even if you close checkout.');

      const started = Date.now();
      while (typeof window.Cashfree !== 'function' && Date.now() - started < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (typeof window.Cashfree !== 'function') {
        showToast('Payment gateway failed to load. Check your connection and retry.', 'error');
        setPaying(false);
        return;
      }

      const cashfreeCheckout = window.Cashfree({
        mode: createData.mode === 'production' ? 'production' : 'sandbox',
      });

      console.info('[PAYMENT_SUCCESS] Opening Cashfree checkout:', {
        cashfreeOrderId: createData.cashfreeOrderId,
        mode: createData.mode
      });
      try {
        const checkoutResult = await cashfreeCheckout.checkout({
          paymentSessionId: createData.paymentSessionId,
          redirectTarget: '_modal',
        });
        console.info('[PAYMENT_RETURN] Cashfree checkout returned control:', {
          cashfreeOrderId: createData.cashfreeOrderId,
          hasError: Boolean(checkoutResult?.error),
          hasPaymentDetails: Boolean(checkoutResult?.paymentDetails)
        });
      } catch (checkoutError) {
        console.warn('[PAYMENT_RETURN] Cashfree checkout closed or returned an error; checking server payment status:', {
          cashfreeOrderId: createData.cashfreeOrderId,
          errorName: checkoutError instanceof Error ? checkoutError.name : 'UnknownError'
        });
      }
      await recoverPayment(createData.cashfreeOrderId);
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Could not reach the payment service.';
      setPaymentMessage(`Payment confirmation pending. ${details} Retry without submitting payment again.`);
      setPaying(false);
    }
  }

  useEffect(() => {
    if (document.getElementById('cashfree-checkout-js')) return;
    const script = document.createElement('script');
    script.id = 'cashfree-checkout-js';
    script.src = 'https://sdk.cashfree.com/js/v3/cashfree.js';
    document.body.appendChild(script);
  }, []);

  if (loading) return null;

  const toggleClass = (active) => `toggle-option${active ? ' active' : ''}`;
  let summaryNote = '';
  if (!hasFiles) summaryNote = 'Please upload at least one file to continue.';
  else if (pagesStillDetecting) summaryNote = 'Detecting page count…';
  else if (filesMissingSettings) summaryNote = 'Please choose printing settings for all files.';

  return (
    <>
      <div className="app-layout">
        <DashboardSidebar userName={displayName} />

        <main className="main-content">
          {paymentMessage && (
            <div role="status" aria-live="polite" style={{ marginBottom: '1rem', padding: '1rem', borderRadius: '0.75rem', background: '#eff6ff' }}>
              <p style={{ margin: 0 }}>{paymentMessage}</p>
              {!paying && recoveryOrderId && (
                <button
                  type="button"
                  className="ticket-btn ticket-btn-outline"
                  style={{ marginTop: '0.75rem' }}
                  onClick={() => recoverPaymentRef.current(recoveryOrderId)}
                >
                  Check payment again
                </button>
              )}
            </div>
          )}
          <a href="/dashboard" className="back-link">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            Back to Dashboard
          </a>

          <div className="content-header" style={{ marginBottom: '1.5rem' }}>
            <div>
              <h1 className="page-title">Create Order</h1>
              <p className="page-subtitle">Configure your print settings and upload documents.</p>
            </div>
          </div>

          <div className="new-order-layout">
            <div className="order-steps">

              {/* Step 1: Upload */}
              <div className="step-card">
                <div className="step-header">
                  <div className="step-number">1</div>
                  <span className="step-title">Upload Documents</span>
                </div>

                <div
                  className={`upload-zone${dragOver ? ' dragover' : ''}`}
                  id="uploadZone"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles([...e.dataTransfer.files]); }}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    id="fileInput"
                    multiple
                    accept=".pdf,.docx,.doc,.png,.jpg,.jpeg"
                    onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }}
                  />
                  <div className="upload-zone-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="16 16 12 12 8 16"></polyline>
                      <line x1="12" y1="12" x2="12" y2="21"></line>
                      <path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"></path>
                    </svg>
                  </div>
                  <h3>Drag &amp; drop files or click to browse</h3>
                  <p>Support for PDF, DOCX, PNG, JPG &nbsp;(Up to 10 files)</p>
                </div>

                <div className="files-list" id="filesList">
                  {files.length === 0 ? (
                    <div className="empty-files-state" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                      <p>No files uploaded yet</p>
                      <p style={{ fontSize: '0.85rem', marginBottom: '1rem' }}>Upload your PDF files to start your print order.</p>
                      <button className="btn btn-secondary" onClick={() => fileInputRef.current?.click()}>
                        + Upload PDFs
                      </button>
                    </div>
                  ) : (
                    <>
                      {files.map((f) => {
                        let pagesText;
                        if (f.pages === null) {
                          pagesText = (
                            <span className="file-pages-detecting">
                              <span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2 }}></span> Detecting pages…
                            </span>
                          );
                        } else {
                          pagesText = `${f.pages} page${f.pages > 1 ? 's' : ''}${f.estimated ? ' (estimated)' : ''}`;
                        }
                        const pdfTotal = filePrintingCost(f);
                        return (
                          <div className="file-item" key={f.key} style={{
                            display: 'flex',
                            flexDirection: 'column',
                            padding: '1rem',
                            borderBottom: '1px solid #eee',
                            gap: '0.75rem',
                            background: '#f9fafb',
                            borderRadius: '8px',
                            marginBottom: '0.75rem'
                          }}>
                            <div className="file-item-head">
                              <div className="file-item-main">
                                <div className="file-icon" style={{ fontSize: '1.5rem' }}>📄</div>
                                <div className="file-item-info">
                                  <div className="file-item-name" style={{ fontWeight: '600' }}>{f.file.name}</div>
                                  <div className="file-item-size" style={{ fontSize: '0.8rem', color: '#666' }}>{formatSize(f.file.size)} · {pagesText}</div>
                                </div>
                              </div>
                              <button className="file-remove" title="Remove" onClick={() => removeFile(f.key)}>✕</button>
                            </div>

                            <div className="file-item-settings">
                              <div className="file-item-row">
                                <div className="counter" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                  <span style={{ fontSize: '0.85rem', color: '#666' }}>Copies:</span>
                                  <button className="counter-btn" onClick={() => updateFileCopies(f.key, -1)}>−</button>
                                  <span className="counter-value" style={{ minWidth: '1.5rem', textAlign: 'center' }}>{f.copies || 1}</span>
                                  <button className="counter-btn" onClick={() => updateFileCopies(f.key, 1)}>+</button>
                                </div>
                                <div className="file-item-options">
                                  <button
                                    className={`btn btn-sm ${f.printingSide === 'single' ? 'btn-primary' : 'btn-outline'}`}
                                    onClick={() => updateFilePrintingSide(f.key, 'single')}
                                    style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                                  >
                                    Single Side (₹2)
                                  </button>
                                  <button
                                    className={`btn btn-sm ${f.printingSide === 'double' ? 'btn-primary' : 'btn-outline'}`}
                                    onClick={() => updateFilePrintingSide(f.key, 'double')}
                                    style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                                  >
                                    Both Sides (₹3)
                                  </button>
                                </div>
                              </div>
                              <div className="file-item-row">
                                <span style={{ fontSize: '0.85rem', color: '#666' }}>Color Mode:</span>
                                <div className="file-item-options">
                                  <button
                                    className={`btn btn-sm ${f.colorMode === 'bw' ? 'btn-primary' : 'btn-outline'}`}
                                    onClick={() => updateFileColorMode(f.key, 'bw')}
                                    style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                                  >
                                    B&amp;W (₹2)
                                  </button>
                                  <button
                                    className={`btn btn-sm ${f.colorMode === 'color' ? 'btn-primary' : 'btn-outline'}`}
                                    onClick={() => updateFileColorMode(f.key, 'color')}
                                    style={{ fontSize: '0.75rem', padding: '0.25rem 0.5rem' }}
                                  >
                                    Color (₹5)
                                  </button>
                                </div>
                              </div>
                              <div style={{ textAlign: 'right', fontSize: '0.85rem', fontWeight: '600', color: 'var(--primary)' }}>
                                PDF Total: ₹{pdfTotal}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <div style={{ marginTop: '1rem', textAlign: 'right' }}>
                        <button className="btn btn-link" onClick={clearAllFiles} style={{ fontSize: '0.85rem', color: '#ef4444', textDecoration: 'none', background: 'none', border: 'none', cursor: 'pointer' }}>
                          Clear All Files
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>

              {/* Step 2: Print Settings */}
              <div className="step-card">
                <div className="step-header">
                  <div className="step-number">2</div>
                  <span className="step-title">Print Settings</span>
                </div>

                <div className="settings-grid">
                  <div className="setting-group">
                    <span className="setting-label">Paper Size</span>
                    <div className="toggle-group" id="sizeGroup">
                      <button className={toggleClass(paperSize === 'A4')} onClick={() => setPaperSize('A4')}>A4</button>
                    </div>
                  </div>
                  <div className="setting-group">
                    <span className="setting-label">Classroom Delivery</span>
                    <div className="toggle-group" id="classroomDeliveryGroup">
                      <button className={toggleClass(!classroomDelivery)} onClick={() => setClassroomDelivery(false)}>No (Free)</button>
                      <button className={toggleClass(classroomDelivery)} onClick={() => setClassroomDelivery(true)}>Yes (+₹10)</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Order Summary */}
            <div className="order-summary">
              <h2 className="summary-title">Order Summary</h2>

              <div className="summary-lines">
                <div className="summary-line">
                  <span className="summary-line-label">Printing Charges ({p.pages} pages)</span>
                  <span className="summary-line-value">₹{p.base + p.a3Extra}</span>
                </div>
                <div className="summary-line">
                  <span className="summary-line-label">Service Charge</span>
                  <span className="summary-line-value">₹{p.serviceCharge}</span>
                </div>
                <div className="summary-line">
                  <span className="summary-line-label">Delivery Charge</span>
                  <span className="summary-line-value">₹{p.deliveryCharge}</span>
                </div>
              </div>

              <div className="summary-divider"></div>

              <div className="summary-total">
                <span className="summary-total-label">Total</span>
                <span className="summary-total-amount">₹{p.total}</span>
              </div>

              <button className="confirm-btn" disabled={!hasFiles || pagesStillDetecting} onClick={openBookingModal}>
                Start Order
              </button>
              <p className="summary-note">{summaryNote}</p>
            </div>
          </div>
          </main>
        </div>

      {/* Booking flow: Time → Location → Payment → Review */}
      <div className="booking-overlay" hidden={!modalOpen} onClick={(e) => { if (e.target === e.currentTarget) closeBookingModal(); }}>
        <div className="booking-panel booking-container" role="dialog" aria-modal="true">
          <button className="booking-close" type="button" aria-label="Close booking" onClick={closeBookingModal}>×</button>

          <div className="cp-nav-steps cp-nav-steps--four" role="navigation" aria-label="Booking steps">
            <button type="button" className={`cp-nav-step${step === 'slot' ? ' is-active' : ''}${step !== 'slot' ? ' is-done' : ''}`} onClick={() => goToStep('slot')}>
              <span className="step-num">01</span><span className="step-title">Time Slot</span>
            </button>
            <span className="step-arrow">→</span>
            <button
              type="button"
              className={`cp-nav-step${step === 'location' ? ' is-active' : ''}${step === 'payment' || step === 'review' ? ' is-done' : ''}`}
              onClick={() => selectedTimeSlot && goToStep('location')}
            >
              <span className="step-num">02</span><span className="step-title">Location</span>
            </button>
            <span className="step-arrow">→</span>
            <button
              type="button"
              className={`cp-nav-step${step === 'payment' ? ' is-active' : ''}${step === 'review' ? ' is-done' : ''}`}
              onClick={() => selectedLocationId && selectedTimeSlot && goToStep('payment')}
            >
              <span className="step-num">03</span><span className="step-title">Payment</span>
            </button>
            <span className="step-arrow">→</span>
            <button
              type="button"
              className={`cp-nav-step${step === 'review' ? ' is-active' : ''}`}
              onClick={() => selectedLocationId && selectedTimeSlot && paymentMethod && goToStep('review')}
            >
              <span className="step-num">04</span><span className="step-title">Review</span>
            </button>
          </div>

          {/* Step 1: Time slots */}
          <section className="cp-step-view" hidden={step !== 'slot'}>
            <div className="cp-view-header">
              <span className="location-tag">🕒 Pickup Schedule</span>
              <h2 className="location-title" style={{ marginTop: '0.5rem' }}>Choose your collection time</h2>
              <p className="location-subtitle">Select a time first. Pickup points for that slot are shown next.</p>
            </div>
            {preOrderMode && (
              <div style={{ background: '#fff7ed', border: '1px solid #fdba74', borderRadius: '0.75rem', padding: '0.75rem 1rem', marginBottom: '1rem', fontSize: '0.85rem', color: '#9a3412' }}>
                🕔 Same-day booking is closed for today. You're pre-ordering for <strong>tomorrow</strong> — the times below are tomorrow's slots.
              </div>
            )}
            <div className="cp-slots-grid">
              {slotsLoading ? (
                <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '1.5rem 0', color: 'var(--text-muted)' }}>
                  <span className="loading-spinner" style={{ borderColor: 'rgba(59,130,246,0.3)', borderTopColor: 'var(--primary)' }}></span>
                  <p style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>Loading available time slots...</p>
                </div>
              ) : slots.map((s) => {
                const isPast = s.status === 'past';
                const isFull = s.status === 'full';
                const isLimited = s.status === 'limited';
                const isDisabled = isPast || isFull;
                const isSelected = selectedTimeSlot === s.time;
                // Still selectable: picking it clears the chosen location (see selectTimeSlot).
                const notAtSelectedLocation = !!selectedLocationId && !isLocationOffered(selectedLocationId, s.time);
                let statusLabel = 'Available';
                if (isPast) statusLabel = 'Unavailable';
                else if (isFull) statusLabel = 'Fully Booked';
                else if (notAtSelectedLocation) statusLabel = `Not at ${selectedLocationName}`;
                else if (isLimited) statusLabel = 'Limited';
                let classes = 'cp-slot-pill';
                if (isPast) classes += ' is-past';
                else if (isFull) classes += ' is-full';
                else if (isLimited || notAtSelectedLocation) classes += ' is-limited';
                else classes += ' is-available';
                if (isSelected) classes += ' is-selected';
                return (
                  <button key={s.time} type="button" className={classes} disabled={isDisabled} onClick={() => selectTimeSlot(s.time)}>
                    <span className="cp-slot-time-text">{s.time}</span>
                    <span className="cp-slot-tag">{statusLabel}</span>
                  </button>
                );
              })}
            </div>
            {preOrderMode && selectedTimeSlot && (
              <p style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#9a3412', fontWeight: 600 }}>
                You're placing a pre-order. Your order will be ready tomorrow at {selectedTimeSlot}.
              </p>
            )}
            <div className="cp-step-footer">
              <button type="button" className="btn btn-primary" disabled={!selectedTimeSlot} onClick={() => goToStep('location')}>
                Continue to Location <span className="arrow-icon">→</span>
              </button>
            </div>
          </section>

          {/* Step 2: Location */}
          <section className="cp-step-view" hidden={step !== 'location'}>
            <div className="cp-view-header">
              <span className="location-tag">📍 Collection Point</span>
              <h2 className="location-title" style={{ marginTop: '0.5rem' }}>Where should we deliver your prints?</h2>
              <p className="location-subtitle">Pickup {preOrderMode ? 'tomorrow' : ''} at <strong style={{ color: 'var(--primary-blue-hover, #2563eb)' }}>{selectedTimeSlot || '—'}</strong>. Points not served at this time are unavailable.</p>
              {preOrderMode && (
                <p className="location-subtitle" style={{ color: '#9a3412', fontWeight: 600 }}>📦 This is a pre-order — same-day booking for today is closed.</p>
              )}
            </div>
            <div className="cp-cards-grid">
              {slotsLoading ? (
                <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '1.5rem 0', color: 'var(--text-muted)' }}>
                  <span className="loading-spinner" style={{ borderColor: 'rgba(59,130,246,0.3)', borderTopColor: 'var(--primary)' }}></span>
                  <p style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>Loading collection points...</p>
                </div>
              ) : LOCATIONS.map((loc) => {
                const locStatus = locationStatuses.find((l) => l.id === loc.id);
                const status = locStatus?.status || 'unavailable';
                const isPastSlot = status === 'past';
                const isUnavailable = status === 'unavailable' || isPastSlot;
                const isFull = status === 'full';
                const isLimited = status === 'limited';
                const isDisabled = isUnavailable || isFull;
                let statusLabel = 'Available';
                if (isUnavailable) statusLabel = 'Booked';
                else if (isFull) statusLabel = 'Fully Booked';
                else if (isLimited) statusLabel = 'Limited';
                let classes = 'cp-loc-card';
                if (loc.id === selectedLocationId && !isDisabled) classes += ' is-selected';
                if (isDisabled) classes += ' is-unavailable';
                return (
                  <button
                    key={loc.id}
                    type="button"
                    className={classes}
                    disabled={isDisabled}
                    onClick={() => handleLocationSelect(loc.id, loc.name)}
                  >
                    <div className="cp-card-icon">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{loc.icon}</svg>
                    </div>
                    <h3 className="cp-card-title">{loc.name}</h3>
                    <p className="cp-card-sub">
                      {loc.sub}
                      {loc.id === 'hostel-gate' && (
                        <span style={{ display: 'block', fontSize: '0.75rem', color: '#3b82f6', fontWeight: '600', marginTop: '0.25rem' }}>
                          Hostel delivery: +₹4
                        </span>
                      )}
                    </p>
                    <span className="cp-loc-status-tag">{statusLabel}</span>
                  </button>
                );
              })}
            </div>
            <div className="cp-step-footer space-between">
              <button type="button" className="btn btn-secondary" onClick={() => goToStep('slot')}>← Back to Time Slot</button>
              <button type="button" className="btn btn-primary" disabled={!selectedLocationId} onClick={() => goToStep('payment')}>
                Continue to Payment <span className="arrow-icon">→</span>
              </button>
            </div>
          </section>

          {/* Step 3: Payment gateway */}
          <section className="cp-step-view" hidden={step !== 'payment'}>
            <div className="cp-view-header">
              <span className="location-tag">💳 Payment</span>
              <h2 className="location-title" style={{ marginTop: '0.5rem' }}>Choose how you'll pay</h2>
              <p className="location-subtitle">Total payable: <strong style={{ color: 'var(--primary-blue-hover, #2563eb)' }}>₹{p.total}</strong></p>
            </div>
            {paymentOptionsLoading && !paymentOptions ? (
              <div style={{ textAlign: 'center', padding: '1.5rem 0', color: 'var(--text-muted)' }}>
                <span className="loading-spinner" style={{ borderColor: 'rgba(59,130,246,0.3)', borderTopColor: 'var(--primary)' }}></span>
                <p style={{ marginTop: '0.5rem', fontSize: '0.85rem' }}>Loading payment options...</p>
              </div>
            ) : (
              <>
                <div className="cp-cards-grid" role="radiogroup" aria-label="Payment options">
                  {PAYMENT_OPTIONS.map((opt) => {
                    const isDisabled = opt.id === 'whatsapp' && !paymentOptions?.hasQr;
                    const isSelected = paymentMethod === opt.id && !isDisabled;
                    let classes = 'cp-loc-card';
                    if (isSelected) classes += ' is-selected';
                    if (isDisabled) classes += ' is-unavailable';
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        className={classes}
                        disabled={isDisabled}
                        onClick={() => setPaymentMethod(opt.id)}
                      >
                        <div className="cp-card-icon">
                          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{opt.icon}</svg>
                        </div>
                        <h3 className="cp-card-title">{opt.name}</h3>
                        <p className="cp-card-sub">{opt.sub}</p>
                        <span className="cp-loc-status-tag">{isDisabled ? 'Not set up' : (isSelected ? 'Selected' : 'Available')}</span>
                      </button>
                    );
                  })}
                </div>

                {paymentMethod === 'whatsapp' && paymentOptions?.hasQr && (
                  <div className="cp-review-box cp-payment-detail">
                    <h3 className="cp-review-heading">Scan to pay ₹{p.total}</h3>
                    <img
                      className="cp-payment-qr"
                      src={`/api/orders/payment-options/qr?v=${paymentOptions.qrVersion || ''}`}
                      alt="Shop payment QR code"
                    />
                    <p className="cp-card-sub">
                      Scan this QR with any UPI app and pay <strong>₹{p.total}</strong>. Your order is placed when you continue,
                      and the shop confirms the payment once it's received.
                    </p>
                  </div>
                )}

                {paymentMethod === 'none' && (
                  <div className="cp-review-box cp-payment-detail">
                    <h3 className="cp-review-heading">Online payment is currently unavailable</h3>
                    <p className="cp-card-sub">Contact the shop for payment instructions:</p>
                    {paymentOptions?.phone ? (
                      <a className="cp-payment-phone" href={`tel:${paymentOptions.phone.replace(/[^\d+]/g, '')}`}>📞 {paymentOptions.phone}</a>
                    ) : (
                      <p className="cp-card-sub"><strong>Please contact the shop at the pickup counter.</strong></p>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="cp-step-footer space-between">
              <button type="button" className="btn btn-secondary" onClick={() => goToStep('location')}>← Back to Location</button>
              <button type="button" className="btn btn-primary" disabled={!paymentMethod} onClick={() => goToStep('review')}>
                Continue to Review <span className="arrow-icon">→</span>
              </button>
            </div>
          </section>

          {/* Step 4: Review */}
          <section className="cp-step-view" hidden={step !== 'review'}>
            <div className="cp-view-header">
              <span className="location-tag">✨ Confirm Details</span>
              <h2 className="location-title" style={{ marginTop: '0.5rem' }}>Review your booking</h2>
              <p className="location-subtitle">Confirm pickup details before proceeding to payment.</p>
              {preOrderMode && (
                <p className="location-subtitle" style={{ color: '#9a3412', fontWeight: 600 }}>
                  You're placing a pre-order. Your order will be ready tomorrow at {selectedTimeSlot || '—'}.
                </p>
              )}
            </div>

            <div className="cp-review-container">
              <div className="cp-review-box">
                <h3 className="cp-review-heading">Customer Details</h3>
                <div className="cp-review-details-list">
                  <div className="cp-review-line">
                    <span>Delivery Option</span>
                    <strong>{classroomDelivery ? 'Classroom Delivery' : (selectedLocationName || '—')}</strong>
                  </div>
                  <div className="cp-review-line">
                    <span>Phone</span>
                    <strong>{guestDetails?.phone || '—'}</strong>
                  </div>
                  <div className="cp-review-line">
                    <span>Class / Section</span>
                    <strong>{guestDetails?.classroom || '—'}</strong>
                  </div>
                </div>
              </div>

              <div className="cp-review-box">
                <h3 className="cp-review-heading">Collection Details</h3>
                <div className="cp-review-row">
                  <div>
                    <span className="cp-review-label">Collection Location</span>
                    <strong className="cp-review-val">{selectedLocationName || '—'}</strong>
                  </div>
                  <button type="button" className="cp-inline-edit" onClick={() => goToStep('location')}>Edit Location</button>
                </div>
                <div className="cp-review-row">
                  <div>
                    <span className="cp-review-label">Collection Time</span>
                    <strong className="cp-review-val">{selectedTimeSlot || '—'}</strong>
                  </div>
                  <button type="button" className="cp-inline-edit" onClick={() => goToStep('slot')}>Edit Time</button>
                </div>
                <div className="cp-review-row">
                  <div>
                    <span className="cp-review-label">Collection Day</span>
                    <strong className="cp-review-val">{preOrderMode ? 'Tomorrow (Pre-order)' : 'Today'}</strong>
                  </div>
                </div>
                <div className="cp-review-row">
                  <div>
                    <span className="cp-review-label">Payment Method</span>
                    <strong className="cp-review-val">{PAYMENT_OPTIONS.find((o) => o.id === paymentMethod)?.name || '—'}</strong>
                  </div>
                  <button type="button" className="cp-inline-edit" onClick={() => goToStep('payment')}>Edit Payment</button>
                </div>
              </div>

              <div className="cp-review-box">
                <h3 className="cp-review-heading">Order Summary</h3>
                <div className="cp-review-details-list">
                  <div className="cp-review-line">
                    <span>Documents ({files.length} file{files.length > 1 ? 's' : ''} · {p.pages} total pages)</span>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                      {files.map(f => (
                        <span key={f.key} style={{ fontSize: '0.8rem' }}>{f.file.name}: {f.copies}x</span>
                      ))}
                    </div>
                  </div>
                  <div className="cp-review-line">
                    <span>Print Mode</span>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }}>
                      {files.map(f => (
                        <span key={f.key} style={{ fontSize: '0.8rem' }}>
                          {f.file.name}: {f.colorMode === 'color' ? 'Color' : 'B&W'}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="cp-review-line">
                    <span>Paper &amp; Side</span>
                    <strong>{`A4`} · {files.some(f => f.printingSide === 'double') ? 'Mixed (S/D)' : (files[0]?.printingSide === 'double' ? 'Double-Sided' : 'Single-Sided')}</strong>
                  </div>
                </div>
                <div className="cp-review-total">
                  <span>Total Amount</span>
                  <strong>₹{p.total}</strong>
                </div>
              </div>
            </div>

            <div className="cp-step-footer space-between" style={{ marginTop: '1.5rem' }}>
              <button type="button" className="btn btn-secondary" onClick={() => goToStep('payment')}>← Back to Payment</button>
              <button type="button" className="btn btn-primary" disabled={paying} onClick={handlePay}>
                {paying ? (
                  <><span className="loading-spinner"></span>&nbsp; Processing…</>
                ) : (
                  <>{paymentMethod === 'cashfree' ? 'Proceed to Payment' : 'Place Order'} <span className="arrow-icon">→</span></>
                )}
              </button>
            </div>
          </section>
        </div>
      </div>

      <Toast toast={toast} />
    </>
  );
}
