import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DashboardSidebar from '../components/DashboardSidebar';
import GuestDetailsModal from '../components/GuestDetailsModal';
import Toast from '../components/Toast';
import PaymentWarningModal from '../components/PaymentWarningModal';
import WhatsAppOrderModal, { WA_ORDER_TEMPLATE } from '../components/WhatsAppOrderModal';
import UpiQrPayment from '../components/UpiQrPayment';
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
  scheduleSaveCurrentOrder,
  storageErrorMessage,
} from '../lib/orderStorage';
import { SLOT_LOCATIONS, TIME_SLOTS, isLocationOffered } from '../lib/slotAvailability';
import { printablePages, parsePageRange, showPageRangeInput, hasInvalidPageRange } from '../lib/pageRange';
import '../styles/style.css';
import '../styles/dashboard.css';

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
const EXT_LABELS = { pdf: 'PDF', doc: 'DOC', docx: 'DOCX', ppt: 'PPT', pptx: 'PPTX', xls: 'XLS', xlsx: 'XLSX', jpg: 'JPG', jpeg: 'JPG', png: 'PNG' };

function fileExtLabel(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? (EXT_LABELS[m[1].toLowerCase()] || m[1].toUpperCase()) : 'FILE';
}

function isImageName(name) {
  return /\.(png|jpg|jpeg)$/i.test(name || '');
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// Booking step 3. 'upi_qr' is the dynamic UPI QR flow (order-first, PENDING until a shop
// admin confirms the payment — POST /api/orders/payment/upi-qr). 'none' is the Personal
// WhatsApp manual-order flow — it opens an instruction modal and WhatsApp, no order/ticket.
const PAYMENT_OPTIONS = [
  {
    id: 'cashfree',
    name: 'Cashfree',
    tone: 'best',
    recommended: true,
    badge: '⭐ RECOMMENDED',
    reliability: 'Most Reliable — Instant Ticket',
    description: <><strong>Instant</strong> payment verification &amp; <strong>instant ticket</strong> generation.</>,
    icon: <><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></>,
  },
  {
    id: 'upi_qr',
    name: 'UPI QR / Scanner',
    tone: 'mid',
    reliability: 'Reliable — Ticket After Verification',
    description: <>Pay by scanning the QR. Ticket generated <strong>after payment verification</strong>.</>,
    icon: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" /></>,
  },
  {
    id: 'none',
    name: 'WhatsApp Order',
    tone: 'manual',
    reliability: 'Manual Confirmation — Verified by Admin',
    description: <>Payment &amp; order confirmation are <strong>verified manually</strong> by the Campus Print team/admin.</>,
    icon: <path d="M20.5 3.5A11 11 0 0 0 3.2 17.3L2 22l4.8-1.2A11 11 0 1 0 20.5 3.5zM12 20a8 8 0 0 1-4.1-1.1l-.3-.2-2.9.7.8-2.8-.2-.3A8 8 0 1 1 12 20zm4.4-6c-.2-.1-1.4-.7-1.6-.8-.2-.1-.4-.1-.5.1-.2.2-.6.8-.8 1-.1.1-.3.2-.5.1a6.6 6.6 0 0 1-3.2-2.8c-.2-.4.2-.4.6-1.2.1-.1 0-.3 0-.4s-.5-1.3-.7-1.7c-.2-.4-.4-.4-.5-.4h-.5a1 1 0 0 0-.7.3c-.2.3-.9.9-.9 2.1s.9 2.5 1 2.6c.1.2 1.8 2.8 4.4 3.9 1.6.7 2.2.7 3 .6.5 0 1.4-.6 1.6-1.1.2-.6.2-1 .1-1.1 0-.1-.2-.2-.4-.3z" />,
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
  const pages = printablePages(f);
  const copies = f?.copies || 1;
  if (f?.colorMode === 'color') return pages * copies * 5;
  if (f?.printingSide === 'double') return Math.ceil(pages / 2) * copies * 3;
  return pages * copies * 2;
}

// Page-based service charge (by total printed pages): 1–10 → ₹1, 11–30 → ₹2, 31+ → ₹3.
// Keep in sync with serviceChargeForPages() in server/pricing.js, which verifies the total.
function serviceChargeForPages(printedPages) {
  if (printedPages <= 10) return 1;
  if (printedPages <= 30) return 2;
  return 3;
}

// Binding add-on: ₹25 binding + ₹1 binding service charge, once per order.
// Keep in sync with PRICING.binding + PRICING.bindingServiceCharge in server/pricing.js.
const BINDING_CHARGE = 26;

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
  // Arriving from Orders → "Pay again": check once, then offer to reopen checkout.
  const payAgain = searchParams.get('pay_again') === '1';
  useBodyClass('app-body');
  useDocumentTitle('New Order – Print Campus');
  const { toast, showToast } = useToast();

  const [currentUser, setCurrentUser] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [guestDetails, setGuestDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [config, setConfig] = useState(null);

  // ── Order configuration state ──
  const [files, setFiles] = useState([]); // [{ key, file, pages, estimated, copies, printingSide, colorMode, pageRange }]
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
  const [paymentMethod, setPaymentMethod] = useState(null); // 'cashfree' | 'upi_qr' | 'none' (WhatsApp order)
  const [paymentOptions, setPaymentOptions] = useState(null); // { phone, upi, hasQr, qrVersion } from /api/orders/payment-options
  const [paymentOptionsLoading, setPaymentOptionsLoading] = useState(false);
  const [paying, setPaying] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState('');
  const [recoveryOrderId, setRecoveryOrderId] = useState(returnedCashfreeOrderId || '');
  const [canRetryPayment, setCanRetryPayment] = useState(false);
  const [paymentWarningOpen, setPaymentWarningOpen] = useState(false);
  const confirmingPaymentRef = useRef(false); // guards against double-firing the pay flow
  const [whatsappModalOpen, setWhatsappModalOpen] = useState(false);
  // Shown when a saved draft has no (valid) email — email is mandatory before ordering.
  const [guestDetailsModalOpen, setGuestDetailsModalOpen] = useState(false);
  const [whatsappOpening, setWhatsappOpening] = useState(false);
  const whatsappOpenedRef = useRef(false); // guards against opening WhatsApp more than once
  const [upiQrData, setUpiQrData] = useState(null);
  const upiSubmittingRef = useRef(false); // guards against creating duplicate UPI orders
  const persistReadyRef = useRef(false);
  // Set before discarding the current draft so the persist effect skips that one change.
  const skipPersistRef = useRef(false);
  // Meta fields NewOrder itself does not own (Home owns them) — carried through saves
  // so re-enabling persistence here doesn't reset them to defaults.
  const draftMetaRef = useRef({ colorOption: 'bw', printingSide: 'single' });
  const handledReturnOrderRef = useRef(null);
  const confirmPaidOrderRef = useRef(null);
  const recoverPaymentRef = useRef(null);
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  const [cfConfirm, setCfConfirm] = useState(null);
  const cfConfirmRef = useRef(null);
  cfConfirmRef.current = cfConfirm;

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
        // Auto-resume the confirmation flow ONLY for an explicit return/resume URL
        // (cf_order / order_id: Cashfree return, Home's resume banner, Orders' Pay Again).
        // A stale cp_pending_payment marker alone must never hijack a normal visit
        // with the 120s confirmation modal — it is still used below for the logged-out
        // access check and the retry fallback.
        if (returnedCashfreeOrderId) setRecoveryOrderId(returnedCashfreeOrderId);

        if (unfinished) {
          draftMetaRef.current = {
            colorOption: unfinished.colorOption === 'color' ? 'color' : 'bw',
            printingSide: unfinished.printingSide === 'double' ? 'double' : 'single',
          };
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
            // 'color' has no state here (color is per-file now as colorMode). Calling the
            // previously-undefined setColorOption threw, silently skipping the restores below.
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

  // Persists the CURRENT draft (files + selections) to IndexedDB on every change so a
  // refresh restores the latest state — file deletions and replacements included.
  useEffect(() => {
    if (!persistReadyRef.current) return;
    if (skipPersistRef.current) {
      skipPersistRef.current = false;
      return;
    }
    scheduleSaveCurrentOrder({
      meta: {
        ...draftMetaRef.current,
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
      onError: (err) => {
        if (typeof showToast === 'function') {
          showToast(storageErrorMessage(err), 'error');
        } else if (showToastRef.current) {
          showToastRef.current(storageErrorMessage(err), 'error');
        }
      },
    });
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
        showToast(`${file.name}: unsupported type. Supported: ${SUPPORTED_LABEL}.`, 'error');
        continue;
      }
      let clientPages = null;
      if (file.type?.startsWith('image/') || isImageName(file.name)) {
        clientPages = 1;
      } else {
        // PDFs get a quick client-side guess; other docs are counted by the server.
        clientPages = await countPdfPagesClient(file);
      }
      accepted.push({
        key: ++fileKeySeq,
        file,
        pages: clientPages || null,
        estimated: false,
        copies: 1,
        printingSide: 'single',
        colorMode: 'bw',
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

  function updateFilePageRange(key, value) {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, pageRange: value } : f)));
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

  const totalPagesCount = files.reduce((sum, f) => sum + (printablePages(f) * f.copies), 0);
  const pagesStillDetecting = files.some((f) => f.pages === null);

  function calcPrice() {
    if (!config) return { pages: 0, base: 0, a3Extra: 0, serviceCharge: 0, deliveryCharge: 0, bindingCharge: 0, total: 0 };

    const printingSubtotal = files.reduce((sum, f) => sum + filePrintingCost(f), 0);

    // Service charge is page-based: 1–10 printed pages ₹1, 11–30 ₹2, 31+ ₹3.
    const serviceCharge = serviceChargeForPages(totalPagesCount || 0);
    let deliveryCharge = 0;
    if (selectedLocationId === 'hostel-gate') {
      deliveryCharge = 3;
    } else if (classroomDelivery) {
      deliveryCharge = 5;
    }
    // Binding is a per-order add-on (₹25 + ₹1 binding service charge), on top of
    // the page-based service charge — neither charge is double-counted.
    const bindingCharge = spiralBinding ? BINDING_CHARGE : 0;

    return {
      pages: totalPagesCount || 0,
      base: printingSubtotal || 0,
      a3Extra: 0,
      serviceCharge,
      deliveryCharge,
      bindingCharge,
      total: (printingSubtotal || 0) + serviceCharge + deliveryCharge + bindingCharge
    };
  }

  const p = calcPrice();
  const hasFiles = files.length > 0;
  const filesMissingSettings = files.some(f => !f.printingSide || !f.colorMode);

  function openBookingModal() {
    if (!hasFiles) { showToast('Please upload at least one file to continue.', 'error'); return; }
    if (pagesStillDetecting) { showToast('Still detecting page count — please wait a moment.', 'error'); return; }
    const invalidRange = files.find((f) => hasInvalidPageRange(f));
    if (invalidRange) { showToast(`Fix the page range for “${invalidRange.file.name}” before continuing.`, 'error'); return; }
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
    let options = { phone: null, upi: null, hasQr: false, qrVersion: null };
    try {
      const res = await fetch('/api/orders/payment-options', { credentials: 'include' });
      if (res.ok) options = await res.json();
    } catch {
      // Cashfree and the WhatsApp order still work without these details.
    }
    setPaymentOptions(options);
    // UPI QR needs the shop's UPI VPA; clear the selection if it isn't configured.
    setPaymentMethod((m) => (m === 'upi_qr' && !options.upi ? null : m));
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
      const wantsDelivery = window.confirm('Do you want Classroom Delivery for an additional ₹5?');
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
    formData.append('email', guestDetails?.email || '');
    formData.append('phone', guestDetails?.phone || '');
    formData.append('classroom', guestDetails?.classroom || '');

    // Per-file settings for backend verification and storage
    const fileSettings = files.map(f => ({
      key: f.key,
      pages: f.pages,
      copies: f.copies,
      printingSide: f.printingSide,
      colorMode: f.colorMode || 'bw',
      pageRange: f.pageRange || ''
    }));
    formData.append('fileSettings', JSON.stringify(fileSettings));

    files.forEach((f) => formData.append('files', f.file));
    return formData;
  }

  function startCashfreeConfirmation(cashfreeOrderId, orderId) {
    setPaying(false);
    setPaymentMessage('');
    setCfConfirm({
      phase: 'confirming',
      cashfreeOrderId,
      orderId: orderId || null,
      startedAt: Date.now(),
      ticketToken: null,
      ticketNumber: null,
      canRetry: false,
    });
  }

  useEffect(() => {
    // Both automated phases must escalate to 'timeout' after 120s: 'received' also polls
    // without any buttons, and without this a stuck verification would trap the user.
    if (!cfConfirm || (cfConfirm.phase !== 'confirming' && cfConfirm.phase !== 'received')) return;
    const timer = setInterval(() => {
      const elapsed = Date.now() - cfConfirm.startedAt;
      if (elapsed >= 120000) {
        setCfConfirm(prev => (prev?.phase === 'confirming' || prev?.phase === 'received')
          ? { ...prev, phase: 'timeout' } : prev);
      } else {
        setCfConfirm(prev => prev ? { ...prev, _tick: Date.now() } : null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [cfConfirm?.phase, cfConfirm?.startedAt]);

  useEffect(() => {
    if (!cfConfirm || cfConfirm.phase === 'success' || cfConfirm.phase === 'failed') return;
    let cancelled = false;
    const interval = cfConfirm.phase === 'timeout' ? 15000 : cfConfirm.phase === 'received' ? 3000 : 4000;

    async function poll() {
      if (cancelled) return;
      const id = cfConfirmRef.current?.cashfreeOrderId;
      if (!id) return;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch('/api/orders/payment/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ cashfree_order_id: id }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (cancelled) return;
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;

        if (data.status === 'PAID') {
          if (data.ticketNumber && data.ticketToken) {
            // The redirect is scheduled by the success-phase effect below: this
            // polling effect's cancellation flag is set as soon as the phase flips.
            setCfConfirm(prev => prev ? { ...prev, phase: 'success', ticketToken: data.ticketToken, ticketNumber: data.ticketNumber } : null);
          } else {
            // PAID but the ticket/token isn't ready yet. Never regress out of 'timeout'
            // (its polling keeps retrying while its buttons keep navigation available).
            setCfConfirm(prev => prev && prev.phase !== 'success' && prev.phase !== 'timeout'
              ? { ...prev, phase: 'received' } : prev);
          }
          return;
        }
        if (data.status === 'PAYMENT_FAILED') {
          setCfConfirm(prev => prev ? { ...prev, phase: 'failed', canRetry: true } : null);
        }
      } catch {
        // Network error — keep polling
      }
    }

    poll();
    const timer = setInterval(poll, interval);
    return () => { cancelled = true; clearInterval(timer); };
  }, [cfConfirm?.phase, cfConfirm?.cashfreeOrderId]);

  // Redirects to the ticket once payment is confirmed and the secure token is in
  // hand. Scheduling here (not inside the polling effect) matters: the polling
  // effect cleans up — cancelling its pending timers — the moment the phase flips
  // to 'success', so a timer created there would never navigate.
  useEffect(() => {
    if (cfConfirm?.phase !== 'success' || !cfConfirm.ticketToken) return;
    const timer = setTimeout(() => finishSuccessfulOrder(cfConfirm.ticketToken), 2000);
    return () => clearTimeout(timer);
  }, [cfConfirm?.phase, cfConfirm?.ticketToken]); 

  useEffect(() => {
    if (loading || !recoveryOrderId || handledReturnOrderRef.current === recoveryOrderId) return;
    handledReturnOrderRef.current = recoveryOrderId;
    const savedPayment = (() => { try { return JSON.parse(localStorage.getItem('cp_pending_payment') || 'null'); } catch { return null; } })();
    if (payAgain) {
      // Orders → "Resume Payment": reopen checkout for the SAME order. The server's
      // retry endpoint reuses the existing order and never creates a duplicate.
      retryCashfreePayment();
      return;
    }
    startCashfreeConfirmation(recoveryOrderId, savedPayment?.orderId || null);
  }, [loading, recoveryOrderId]);

  // Opens Cashfree checkout for one payment attempt, then asks the SERVER whether it
  // was paid. Closing the modal or the return URL never counts as payment.
  async function openCashfreeCheckout(session) {
    try {
      // Recovery hint only: the server is the source of truth for the order.
      localStorage.setItem('cp_pending_payment', JSON.stringify({
        cashfreeOrderId: session.cashfreeOrderId,
        orderId: session.orderId || null,
        createdAt: Date.now()
      }));
    } catch {
      // The order is still recoverable from the Orders page.
    }
    setRecoveryOrderId(session.cashfreeOrderId);
    handledReturnOrderRef.current = session.cashfreeOrderId;
    setCanRetryPayment(false);

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
      mode: session.mode === 'production' ? 'production' : 'sandbox',
    });

    console.info('[PAYMENT_SUCCESS] Opening Cashfree checkout:', {
      cashfreeOrderId: session.cashfreeOrderId,
      mode: session.mode
    });
    let paymentDetails = null;
    try {
      const checkoutResult = await cashfreeCheckout.checkout({
        paymentSessionId: session.paymentSessionId,
        redirectTarget: '_modal',
      });
      paymentDetails = checkoutResult?.paymentDetails || null;
      console.info('[PAYMENT_RETURN] Cashfree checkout returned control:', {
        cashfreeOrderId: session.cashfreeOrderId,
        hasError: Boolean(checkoutResult?.error),
        hasPaymentDetails: Boolean(checkoutResult?.paymentDetails)
      });
    } catch (checkoutError) {
      console.warn('[PAYMENT_RETURN] Cashfree checkout closed or returned an error; checking server payment status:', {
        cashfreeOrderId: session.cashfreeOrderId,
        errorName: checkoutError instanceof Error ? checkoutError.name : 'UnknownError'
      });
    }

    if (paymentDetails) {
      // The student actually went through the payment flow — monitor it with the
      // existing 2-minute confirmation timer.
      startCashfreeConfirmation(session.cashfreeOrderId, session.orderId);
      return;
    }

    // Checkout was left / closed without completing a payment. Explicitly leaving is
    // NOT a confirmed pending payment: never start the 2-minute timer just for leaving.
    // One quick server check catches the rare case where the money was captured anyway.
    let verifiedStatus = null;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const verifyRes = await fetch('/api/orders/payment/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ cashfree_order_id: session.cashfreeOrderId }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const verifyData = await verifyRes.json().catch(() => ({}));
      verifiedStatus = verifyData?.status || null;
    } catch {
      // Could not check — treat as not paid; recovery stays on the Orders page.
    }
    setPaying(false);
    if (verifiedStatus === 'PAID' || verifiedStatus === 'PAYMENT_PROCESSING') {
      // Money is genuinely captured / in flight — this IS a pending payment.
      startCashfreeConfirmation(session.cashfreeOrderId, session.orderId);
      return;
    }
    // Explicitly left before paying: back to Step 4 (Review Order). The draft, files,
    // copies, page settings, location, time slot and payment method are untouched;
    // no duplicate order, no ticket and no pending-payment timer is created.
    setPaymentMessage('');
    if (modalOpen) {
      setStep('review');
    }
    showToast('Payment was not completed. Your order is saved — review it and try checkout again.', 'success');
  }

  // Pays again for the SAME order after a failed / abandoned Cashfree checkout.
  async function retryCashfreePayment() {
    const cashfreeOrderId = cfConfirmRef.current?.cashfreeOrderId || recoveryOrderId;
    if (!cashfreeOrderId || paying) return;
    setPaying(true);
    setCfConfirm(null);
    try {
      const res = await fetch('/api/orders/payment/cashfree/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ cashfree_order_id: cashfreeOrderId })
      });
      const data = await res.json().catch(() => ({}));
      if (data.status === 'PAID' && data.ticketToken) {
        await finishSuccessfulOrder(data.ticketToken);
        return;
      }
      if (!res.ok || !data.paymentSessionId || !data.cashfreeOrderId) {
        showToast(data.message || 'Could not restart the payment. Please retry shortly.', 'error');
        startCashfreeConfirmation(cashfreeOrderId, cfConfirmRef.current?.orderId);
        setCfConfirm(prev => prev ? { ...prev, phase: 'failed', canRetry: true } : null);
        setPaying(false);
        return;
      }
      await openCashfreeCheckout(data);
    } catch {
      showToast('Could not reach the payment service. Please retry.', 'error');
      setPaying(false);
    }
  }

  // Abandons the failed checkout locally (the unpaid order stays visible on the Orders page).
  function dismissFailedPayment() {
    try { localStorage.removeItem('cp_pending_payment'); } catch {}
    setCanRetryPayment(false);
    setPaymentMessage('');
    setRecoveryOrderId('');
    setCfConfirm(null);
  }

  async function handlePay() {
    if (!selectedLocationId || !selectedTimeSlot) {
      showToast('Please select a collection location and time slot.', 'error');
      return;
    }
    if (!hasFiles) { showToast('Please upload at least one file to continue.', 'error'); return; }
    if (filesMissingSettings) { showToast('Please choose printing settings for all files.', 'error'); return; }
    const badRange = files.find((f) => hasInvalidPageRange(f));
    if (badRange) { showToast(`Fix the page range for “${badRange.file.name}” before continuing.`, 'error'); return; }

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

    // UPI QR and WhatsApp have their own flows (requestPayment); only Cashfree pays here.
    if (paymentMethod !== 'cashfree') return;

    setPaying(true);

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
      // Send the actual files so the backend derives the trusted amount from
      // their real content (page counts), not from any client-sent price.
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
      await openCashfreeCheckout(createData);
    } catch (error) {
      const details = error instanceof Error ? error.message : 'Could not reach the payment service.';
      setPaymentMessage(`Payment confirmation pending. ${details} Retry without submitting payment again.`);
      setPaying(false);
    }
  }

  // Review-step button routes by method:
  //  'none'   → Personal WhatsApp instruction modal (no order/payment)
  //  'upi_qr' → create the order + show the UPI QR screen
  //  else     → the pre-payment warning (Cashfree)
  function requestPayment() {
    // Email is mandatory for every order — older saved drafts may predate the field.
    if (!EMAIL_REGEX.test(String(guestDetails?.email || '').trim())) {
      setGuestDetailsModalOpen(true);
      return;
    }
    if (paymentMethod === 'none') {
      whatsappOpenedRef.current = false;
      setWhatsappModalOpen(true);
      return;
    }
    if (paymentMethod === 'upi_qr') {
      startUpiQr();
      return;
    }
    setPaymentWarningOpen(true);
  }

  // Order-first UPI QR: create the PENDING order on the server and show its QR.
  // The guard prevents a double-click from creating two orders.
  async function startUpiQr() {
    if (upiSubmittingRef.current || paying) return;
    upiSubmittingRef.current = true;
    setPaying(true);
    try {
      const res = await fetch('/api/orders/payment/upi-qr', {
        method: 'POST', credentials: 'include', body: buildOrderFormData(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        showToast(data.message || 'Could not start UPI payment. Please try again.', 'error');
        return;
      }
      try { await clearCompletedOrder(); } catch { /* draft cleanup is best-effort */ }
      closeBookingModal();
      setUpiQrData(data); // stays on a pending QR screen — no navigation to the ticket
    } catch {
      showToast('Connection error. Please try again.', 'error');
    } finally {
      setPaying(false);
      upiSubmittingRef.current = false;
    }
  }

  // Normalizes an Indian number to wa.me's international form (digits, no '+').
  function toWhatsappNumber(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) return `91${digits}`;        // bare 10-digit → prefix India
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    return digits;                                         // already has a country code
  }

  // "Continue to WhatsApp": open the existing WhatsApp chat exactly once, prefilled
  // with the order template. No order/ticket is created; the form stays intact.
  function openWhatsApp() {
    if (whatsappOpenedRef.current) return;
    const number = toWhatsappNumber(paymentOptions?.phone);
    if (!number) {
      showToast('WhatsApp number is not configured. Please contact the shop.', 'error');
      return;
    }
    whatsappOpenedRef.current = true;
    setWhatsappOpening(true);
    const url = `https://wa.me/${number}?text=${encodeURIComponent(WA_ORDER_TEMPLATE)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
    setWhatsappModalOpen(false);
    setWhatsappOpening(false);
  }

  // "Continue to Payment": run the existing, unchanged pay flow exactly once.
  // The synchronous ref guard blocks double-clicks before React re-renders.
  async function confirmPaymentWarning() {
    if (confirmingPaymentRef.current || paying) return;
    confirmingPaymentRef.current = true;
    setPaymentWarningOpen(false);
    try {
      await handlePay();
    } finally {
      confirmingPaymentRef.current = false;
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
  else if (files.some((f) => hasInvalidPageRange(f))) summaryNote = 'Fix the invalid page range to continue.';
  else if (filesMissingSettings) summaryNote = 'Please choose printing settings for all files.';

  return (
    <>
      <div className="app-layout">
        <DashboardSidebar userName={displayName} />

        <main className="main-content">
          {paymentMessage && !cfConfirm && (
            <div role="status" aria-live="polite" style={{ marginBottom: '1rem', padding: '1rem', borderRadius: '0.75rem', background: '#eff6ff' }}>
              <p style={{ margin: 0 }}>{paymentMessage}</p>
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
                    accept={ACCEPT_ATTR}
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
                  <p>Support for {SUPPORTED_LABEL} &nbsp;(Up to 10 files)</p>
                </div>

                <div className="files-list" id="filesList">
                  {files.length === 0 ? (
                    <div className="empty-files-state" style={{ textAlign: 'center', padding: '2rem', color: 'var(--text-muted)' }}>
                      <p>No files uploaded yet</p>
                      <p style={{ fontSize: '0.85rem', marginBottom: 0 }}>Upload your files to start your print order.</p>
                    </div>
                  ) : (
                    <>
                      {files.map((f) => {
                        const typeLabel = fileExtLabel(f.file.name);
                        const pageRangeState = f.pageRange && showPageRangeInput(f) ? parsePageRange(f.pageRange, f.pages) : null;
                        const rangeErr = pageRangeState && !pageRangeState.ok ? pageRangeState.message : '';
                        let pagesText;
                        if (f.pages === null) {
                          pagesText = (
                            <span className="file-pages-detecting">
                              <span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2 }}></span> Detecting pages…
                            </span>
                          );
                        } else if (f.estimated) {
                          // No reliable automatic count for this type — let the user confirm it.
                          pagesText = (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                              <span>Pages:</span>
                              <input
                                type="number" min="1" max="2000" value={f.pages}
                                onChange={(e) => updateFilePages(f.key, e.target.value)}
                                style={{ width: '4rem', padding: '0.15rem 0.35rem', border: '1px solid #ddd', borderRadius: '4px', fontSize: '0.8rem' }}
                              />
                              <span style={{ color: '#9a3412' }}>(confirm — page count finalized at processing)</span>
                            </span>
                          );
                        } else {
                          pagesText = `${f.pages} page${f.pages > 1 ? 's' : ''}`;
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
                                <div className="file-icon" style={{ fontSize: '1.5rem' }}>{isImageName(f.file.name) ? '🖼️' : '📄'}</div>
                                <div className="file-item-info">
                                  <div className="file-item-name" style={{ fontWeight: '600' }}>{f.file.name}</div>
                                  <div className="file-item-size" style={{ fontSize: '0.8rem', color: '#666' }}>
                                    <span style={{ fontWeight: 700, color: '#374151' }}>{typeLabel}</span> · {formatSize(f.file.size)} · {pagesText}
                                  </div>
                                </div>
                              </div>
                              <button type="button" className="file-remove" aria-label={`Remove ${f.file.name}`} title="Remove document" onClick={() => removeFile(f.key)}>
                                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
                                  <polyline points="3 6 5 6 21 6"></polyline>
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                  <line x1="10" y1="11" x2="10" y2="17"></line>
                                  <line x1="14" y1="11" x2="14" y2="17"></line>
                                </svg>
                              </button>
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
                              {showPageRangeInput(f) && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                                    <label htmlFor={`page-range-${f.key}`} style={{ fontSize: '0.85rem', color: '#666' }}>Page Range:</label>
                                    <input
                                      id={`page-range-${f.key}`}
                                      type="text"
                                      inputMode="numeric"
                                      value={f.pageRange || ''}
                                      placeholder={`e.g. 33-55 (of ${f.pages})`}
                                      onChange={(e) => updateFilePageRange(f.key, e.target.value)}
                                      style={{ width: '7.5rem', padding: '0.25rem 0.5rem', border: `1px solid ${rangeErr ? '#ef4444' : '#ddd'}`, borderRadius: '6px', fontSize: '0.85rem' }}
                                    />
                                    <span style={{ fontSize: '0.75rem', color: '#888' }}>Leave empty to print all {f.pages} pages</span>
                                  </div>
                                  {rangeErr && (
                                    <span role="alert" style={{ fontSize: '0.78rem', color: '#b91c1c', fontWeight: 600 }}>{rangeErr}</span>
                                  )}
                                </div>
                              )}
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
                      <button className={toggleClass(classroomDelivery)} onClick={() => setClassroomDelivery(true)}>Yes (+₹5)</button>
                    </div>
                  </div>
                  <div className="setting-group">
                    <span className="setting-label">Binding</span>
                    <div className="toggle-group" id="bindingGroup" role="radiogroup" aria-label="Binding">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={!spiralBinding}
                        className={toggleClass(!spiralBinding)}
                        onClick={() => setSpiralBinding(false)}
                      >No (Free)</button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={spiralBinding}
                        className={toggleClass(spiralBinding)}
                        onClick={() => setSpiralBinding(true)}
                      >Yes (+₹26)</button>
                    </div>
                    <span style={{ fontSize: '0.72rem', color: '#888' }}>₹25 binding + ₹1 binding service charge</span>
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
                {spiralBinding && (
                  <div className="summary-line">
                    <span className="summary-line-label">Binding (₹25 + ₹1 service)</span>
                    <span className="summary-line-value">₹{p.bindingCharge}</span>
                  </div>
                )}
              </div>

              <div className="summary-divider"></div>

              <div className="summary-total">
                <span className="summary-total-label">Total</span>
                <span className="summary-total-amount">₹{p.total}</span>
              </div>

              <button className="confirm-btn" disabled={!hasFiles || pagesStillDetecting || files.some((f) => hasInvalidPageRange(f))} onClick={openBookingModal}>
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
            <div className="cp-step-footer space-between">
              <button type="button" className="btn btn-secondary" onClick={closeBookingModal}>← Back to Order</button>
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
                          Hostel delivery: +₹3
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
                    const isDisabled = opt.id === 'upi_qr' && !paymentOptions?.upi;
                    const isSelected = paymentMethod === opt.id && !isDisabled;
                    let classes = 'cp-loc-card cp-pay-card';
                    if (opt.recommended) classes += ' cp-pay-recommended';
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
                        {opt.badge && <span className="cp-pay-badge">{opt.badge}</span>}
                        <p className={`cp-pay-reliability cp-pay-reliability--${opt.tone}`}>{opt.reliability}</p>
                        <p className="cp-card-sub cp-pay-desc">{opt.description}</p>
                        <span className="cp-loc-status-tag">{isDisabled ? 'Not set up' : (isSelected ? 'Selected' : 'Available')}</span>
                      </button>
                    );
                  })}
                </div>

                {paymentMethod === 'upi_qr' && (
                  <div className="cp-review-box cp-payment-detail">
                    <h3 className="cp-review-heading">Pay via UPI QR</h3>
                    <p className="cp-card-sub">
                      When you continue, we'll create your order and show a UPI QR for <strong>₹{p.total}</strong>.
                      Scan it with any UPI app to pay. Your payment is <strong>confirmed by our team</strong> — the
                      order stays <strong>pending</strong> until then.
                    </p>
                    {!paymentOptions?.upi && (
                      <p className="cp-card-sub"><strong>UPI isn't set up yet — please choose another method.</strong></p>
                    )}
                  </div>
                )}

                {paymentMethod === 'none' && (
                  <div className="cp-review-box cp-payment-detail">
                    <h3 className="cp-review-heading">Order via Personal WhatsApp</h3>
                    <p className="cp-card-sub">
                      This is a <strong>manual order</strong>. When you continue, you'll get step-by-step WhatsApp
                      instructions. <strong>No ticket is auto-generated</strong> — our team verifies and confirms your order.
                    </p>
                    {!paymentOptions?.phone && (
                      <p className="cp-card-sub"><strong>WhatsApp number isn't set up yet — please contact the shop at the pickup counter.</strong></p>
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
                  <div className="cp-review-line">
                    <span>Binding</span>
                    <strong>{spiralBinding ? `Yes — ₹${BINDING_CHARGE} (₹25 binding + ₹1 service)` : 'No — ₹0'}</strong>
                  </div>
                  <div className="cp-review-line">
                    <span>Printing ({p.pages} pages)</span>
                    <strong>₹{p.base + p.a3Extra}</strong>
                  </div>
                  <div className="cp-review-line">
                    <span>Service Charge</span>
                    <strong>₹{p.serviceCharge}</strong>
                  </div>
                  <div className="cp-review-line">
                    <span>Delivery Charge</span>
                    <strong>₹{p.deliveryCharge}</strong>
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
              <button type="button" className="btn btn-primary" disabled={paying} onClick={requestPayment}>
                {paying ? (
                  <><span className="loading-spinner"></span>&nbsp; Processing…</>
                ) : (
                  <>{paymentMethod === 'cashfree' ? 'Proceed to Payment' : paymentMethod === 'none' ? 'Order via WhatsApp' : paymentMethod === 'upi_qr' ? 'Pay via UPI QR' : 'Place Order'} <span className="arrow-icon">→</span></>
                )}
              </button>
            </div>
          </section>
        </div>
      </div>

      <PaymentWarningModal
        isOpen={paymentWarningOpen}
        processing={paying}
        onCancel={() => setPaymentWarningOpen(false)}
        onConfirm={confirmPaymentWarning}
      />

      <WhatsAppOrderModal
        isOpen={whatsappModalOpen}
        opening={whatsappOpening}
        onCancel={() => setWhatsappModalOpen(false)}
        onContinue={openWhatsApp}
        whatsappNumber={paymentOptions?.phone || ''}
        upi={paymentOptions?.upi || ''}
        hasQr={!!paymentOptions?.hasQr}
        qrVersion={paymentOptions?.qrVersion}
        fileInfo={{ supported: SUPPORTED_LABEL, maxSizeMb: Math.round(MAX_FILE_BYTES / (1024 * 1024)), maxFiles: MAX_ORDER_FILES }}
        showToast={showToast}
      />

      {upiQrData && (
        <UpiQrPayment
          data={upiQrData}
          showToast={showToast}
          onClose={() => setUpiQrData(null)}
          onViewTicket={() => navigate(`/ticket?token=${encodeURIComponent(upiQrData.ticketToken)}`)}
        />
      )}

      {cfConfirm && (() => {
        const timeLeft = Math.max(0, 120 - Math.floor((Date.now() - cfConfirm.startedAt) / 1000));
        const progress = Math.min(100, ((Date.now() - cfConfirm.startedAt) / 120000) * 100);
        return (
          <div className="booking-overlay" style={{ zIndex: 1100 }}>
            <div className="booking-panel" style={{ maxWidth: 440, textAlign: 'center', padding: '2rem 1.5rem', margin: '2rem auto' }}>

              {cfConfirm.phase === 'confirming' && (<>
                <div style={{ width: 56, height: 56, margin: '0 auto 1rem', borderRadius: '50%', background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <span className="loading-spinner" style={{ width: 28, height: 28 }} />
                </div>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.25rem' }}>Confirming your payment...</h2>
                <p style={{ color: '#6b7280', fontSize: '0.9rem', margin: '0 0 1.25rem' }}>Confirming your payment with Cashfree. This usually takes a few seconds.</p>
                <div style={{ background: '#e5e7eb', borderRadius: 999, height: 6, margin: '0 0 0.75rem', overflow: 'hidden' }}>
                  <div style={{ background: '#3b82f6', height: '100%', width: `${progress}%`, borderRadius: 999, transition: 'width 1s linear' }} />
                </div>
                <p style={{ fontSize: '1.5rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: '#1e3a5f', margin: '0 0 0.5rem' }}>
                  {Math.floor(timeLeft / 60)}:{String(timeLeft % 60).padStart(2, '0')}
                </p>
              </>)}

              {cfConfirm.phase === 'received' && (<>
                <div style={{ width: 56, height: 56, margin: '0 auto 1rem', borderRadius: '50%', background: '#ecfdf5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                </div>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.25rem' }}>Payment received!</h2>
                <p style={{ color: '#6b7280', fontSize: '0.9rem', margin: '0 0 1rem' }}>Preparing your collection ticket...</p>
                <span className="loading-spinner" style={{ display: 'block', margin: '0 auto', width: 24, height: 24 }} />
              </>)}

              {cfConfirm.phase === 'success' && (<>
                <div style={{ width: 56, height: 56, margin: '0 auto 1rem', borderRadius: '50%', background: '#ecfdf5', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                </div>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: '#059669', margin: '0 0 0.25rem' }}>Payment successful!</h2>
                {cfConfirm.ticketNumber && <p style={{ fontWeight: 600, fontSize: '1.1rem', margin: '0.25rem 0' }}>{cfConfirm.ticketNumber}</p>}
                <p style={{ color: '#6b7280', fontSize: '0.9rem' }}>Redirecting to your ticket...</p>
              </>)}

              {cfConfirm.phase === 'timeout' && (<>
                <div style={{ width: 56, height: 56, margin: '0 auto 1rem', borderRadius: '50%', background: '#fef3c7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#d97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                </div>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.25rem' }}>Payment taking longer to confirm</h2>
                <p style={{ color: '#6b7280', fontSize: '0.9rem', margin: '0 0 0.25rem' }}>Your payment is taking longer to confirm. <strong>Please do not pay again.</strong></p>
                <p style={{ color: '#9ca3af', fontSize: '0.8rem', margin: '0 0 1.25rem' }}>We're still checking in the background. Your ticket will appear automatically once confirmed.</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <button type="button" className="ticket-btn ticket-btn-primary" onClick={() => navigate('/orders')}>Go to Orders</button>
                </div>
              </>)}

              {cfConfirm.phase === 'failed' && (<>
                <div style={{ width: 56, height: 56, margin: '0 auto 1rem', borderRadius: '50%', background: '#fef2f2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
                </div>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.25rem' }}>Payment failed</h2>
                <p style={{ color: '#6b7280', fontSize: '0.9rem', margin: '0 0 1.25rem' }}>This payment did not go through. Your order is saved — you can try paying again.</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <button type="button" className="ticket-btn ticket-btn-primary" onClick={retryCashfreePayment}>Pay Again for This Order</button>
                  <button type="button" className="ticket-btn ticket-btn-outline" onClick={() => navigate('/orders')}>My Orders</button>
                  <button type="button" className="ticket-btn ticket-btn-outline" onClick={dismissFailedPayment} style={{ color: '#6b7280' }}>Dismiss</button>
                </div>
              </>)}

              {(cfConfirm.phase === 'confirming' || cfConfirm.phase === 'timeout') && cfConfirm.orderId && (
                <div style={{ marginTop: '1rem', padding: '0.5rem 0.75rem', background: '#f9fafb', borderRadius: 8, fontSize: '0.8rem', color: '#9ca3af' }}>
                  Order #{cfConfirm.orderId}
                </div>
              )}


            </div>
          </div>
        );
      })()}

      {guestDetailsModalOpen && (
        <GuestDetailsModal
          isOpen
          initialValues={{
            fullName: guestDetails?.fullName || '',
            email: guestDetails?.email || '',
            phone: guestDetails?.phone || '',
            classroom: guestDetails?.classroom || '',
          }}
          onClose={() => setGuestDetailsModalOpen(false)}
          onSubmit={(details) => {
            const guest = {
              fullName: details.fullName,
              email: details.email,
              phone: details.phone,
              classroom: details.classroom,
            };
            setGuestDetails(guest);
            setDisplayName(details.fullName || displayName);
            try {
              localStorage.setItem('cp_guest_details', JSON.stringify(guest));
            } catch {
              // localStorage unavailable
            }
            setGuestDetailsModalOpen(false);
          }}
        />
      )}

      <Toast toast={toast} />
    </>
  );
}
