import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import DashboardSidebar from '../components/DashboardSidebar';
import GuestDetailsModal from '../components/GuestDetailsModal';
import Toast from '../components/Toast';
import PaymentWarningModal from '../components/PaymentWarningModal';
import WhatsAppOrderModal, { WA_ORDER_TEMPLATE } from '../components/WhatsAppOrderModal';
import useToast from '../lib/useToast';
import useBodyClass from '../lib/useBodyClass';
import useDocumentTitle from '../lib/useDocumentTitle';
import {
  MAX_FILE_BYTES,
  MAX_ORDER_FILES,
  clearCompletedOrder,
  buildFileSettingsPayload,
  flushSaveCurrentOrder,
  hasCompleteFileSettings,
  loadCurrentOrder,
  removeCurrentOrder,
  saveCurrentOrder,
  scheduleSaveCurrentOrder,
  storageErrorMessage,
} from '../lib/orderStorage';
import { SLOT_LOCATIONS, TIME_SLOTS, isLocationOffered } from '../lib/slotAvailability';
import {
  ACADEMIC_BLOCK_ID,
  academicBlockLocationName,
  classroomDeliveryNoticeText,
  locationOptionName,
} from '../lib/classroomDelivery';
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

function toggleClass(isActive) {
  return `toggle-option${isActive ? ' active' : ''}`;
}

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

// Booking step 3. 'none' is the Personal
// WhatsApp manual-order flow — it opens an instruction modal and WhatsApp, no order/ticket.
const PAYMENT_OPTIONS = [
  {
    id: 'cashfree',
    name: 'Online Payment',
    tone: 'best',
    recommended: true,
    badge: '⭐ RECOMMENDED',
    reliability: 'Most Reliable — Instant Ticket',
    description: <><strong>Instant</strong> payment verification &amp; <strong>instant ticket</strong> generation.</>,
    icon: <><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></>,
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

// Mirrors server/pricing.js. The server remains authoritative at submission.
function filePrintingCost(f) {
  const pages = printablePages(f);
  const copies = f?.copies || 1;
  if (f?.colorMode === 'color') return pages * copies * (f?.printingSide === 'double' ? 12 : 10);
  if (f?.printingSide === 'double') return pages * copies * 3;
  return pages * copies * 2;
}

const BINDING_CHARGE = 25;
const BINDING_SERVICE_FEE = 1;
const BINDING_TOTAL = BINDING_CHARGE + BINDING_SERVICE_FEE;

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
  const [files, setFiles] = useState([]);
  const [paperSize, setPaperSize] = useState('A4');
  const [spiralBinding, setSpiralBinding] = useState(false);

  useEffect(() => {
    const hasBinding = files.some((f) => f.spiralBinding && printablePages(f) >= 5);
    setSpiralBinding(hasBinding);
  }, [files]);
  const [expressDelivery, setExpressDelivery] = useState(false);
  const [classroomDelivery, setClassroomDelivery] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState(null);
  const [selectedLocationName, setSelectedLocationName] = useState(null);
  const [selectedTimeSlot, setSelectedTimeSlot] = useState(null);
  const [paymentMethod, setPaymentMethod] = useState(null);
  const [step, setStep] = useState('slot');
  const [modalOpen, setModalOpen] = useState(false);
  const [paymentOptionsLoading, setPaymentOptionsLoading] = useState(false);
  const [paymentOptions, setPaymentOptions] = useState(null);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slots, setSlots] = useState([]);
  const [preOrderMode, setPreOrderMode] = useState(false);
  const [locationStatuses, setLocationStatuses] = useState([]);
  const [paying, setPaying] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState('');
  const [recoveryOrderId, setRecoveryOrderId] = useState('');
  const [canRetryPayment, setCanRetryPayment] = useState(false);
  const [guestDetailsModalOpen, setGuestDetailsModalOpen] = useState(false);
  const [whatsappModalOpen, setWhatsappModalOpen] = useState(false);
  const [whatsappOpening, setWhatsappOpening] = useState(false);
  const [paymentWarningOpen, setPaymentWarningOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  // Set before discarding the current draft so the persist effect skips that one change.
  const skipPersistRef = useRef(false);
  const persistReadyRef = useRef(false);
  const fileInputRef = useRef(null);
  const confirmingPaymentRef = useRef(false);
  const whatsappOpenedRef = useRef(false);
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
            const restoredFiles = unfinished.files.map((entry) => ({ ...entry }));
            if (unfinished.spiralBinding && !restoredFiles.some((entry) => entry.spiralBinding)) {
              restoredFiles[0] = { ...restoredFiles[0], spiralBinding: true };
            }
            const restoredKeys = restoredFiles.map((entry) => Number(entry.key)).filter((n) => Number.isFinite(n));
            if (restoredKeys.length) fileKeySeq = Math.max(fileKeySeq, ...restoredKeys);
            setFiles(restoredFiles);
            setSpiralBinding(restoredFiles.some((entry) => entry.spiralBinding && printablePages(entry) >= 5));
          }
          setPaperSize('A4');
          setExpressDelivery(unfinished.expressDelivery);
          const classroomOn = !!unfinished.classroomDelivery;
          setClassroomDelivery(classroomOn);
          // Classroom delivery is always Academic Block; otherwise restore the saved pairing
          // if it still exists in the slot matrix.
          const restoredLocationId = classroomOn ? ACADEMIC_BLOCK_ID : unfinished.selectedLocationId;
          const restoredLocationName = classroomOn
            ? academicBlockLocationName(true)
            : unfinished.selectedLocationName;
          const savedPairValid = !restoredLocationId || !unfinished.selectedTimeSlot
            || isLocationOffered(restoredLocationId, unfinished.selectedTimeSlot);
          setSelectedLocationId(savedPairValid ? restoredLocationId : null);
          setSelectedLocationName(savedPairValid ? restoredLocationName : null);
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
            setPaperSize('A4');
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
        selectedLocationId: classroomDelivery ? ACADEMIC_BLOCK_ID : selectedLocationId,
        selectedLocationName: classroomDelivery
          ? academicBlockLocationName(true)
          : (selectedLocationId === ACADEMIC_BLOCK_ID ? academicBlockLocationName(false) : selectedLocationName),
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
      const isImg = file.type?.startsWith('image/') || isImageName(file.name);
      if (isImg) {
        clientPages = 1;
      } else {
        // PDFs get a quick client-side guess; other docs are counted by the server.
        clientPages = await countPdfPagesClient(file);
      }
      const hasExactClientPages = typeof clientPages === 'number' && clientPages >= 1;
      accepted.push({
        key: ++fileKeySeq,
        file,
        pages: hasExactClientPages ? clientPages : null,
        estimated: false,
        requiresConfirmation: false,
        pagesConfirmed: hasExactClientPages,
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
          if (result && typeof result.pages === 'number' && result.pages >= 1 && !result.estimated) {
            return {
              ...entry,
              pages: result.pages,
              estimated: false,
              requiresConfirmation: false,
              pagesConfirmed: true
            };
          }
          return {
            ...entry,
            pages: null,
            estimated: true,
            requiresConfirmation: true,
            pagesConfirmed: false
          };
        }));
      }
    } catch {
      setFiles((prev) => prev.map((entry) =>
        needDetection.some((n) => n.key === entry.key)
          ? { ...entry, pages: null, estimated: true, requiresConfirmation: true, pagesConfirmed: false }
          : entry
      ));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function updateFilePages(key, val) {
    const parsed = parseInt(val, 10);
    const pages = Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
    setFiles((prev) => prev.map((f) => (
      f.key === key
        ? {
            ...f,
            pages,
            estimated: true,
            requiresConfirmation: true,
            pagesConfirmed: pages !== null
          }
        : f
    )));
  }

  function removeFile(key) {
    setFiles((prev) => prev.filter((f) => f.key !== key));
  }

  function updateFilePrintingSide(key, side) {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, printingSide: side } : f)));
  }

  function updateFileBinding(key, bindingOn) {
    setFiles((prev) => {
      const updated = prev.map((f) => {
        if (f.key !== key) return f;
        const isEligible = printablePages(f) >= 5;
        return { ...f, spiralBinding: isEligible ? bindingOn : false, bindingDescription: isEligible && bindingOn ? (f.bindingDescription || '') : '' };
      });
      setSpiralBinding(updated.some((f) => f.spiralBinding && printablePages(f) >= 5));
      return updated;
    });
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
      if (target && (Number.isSafeInteger(target.copies) ? target.copies : 1) <= 1) {
        removeFile(key);
        return;
      }
    }
    setFiles((prev) => prev.map((f) => (
      f.key === key
        ? { ...f, copies: Math.max(1, (Number.isSafeInteger(f.copies) ? f.copies : 1) + delta) }
        : f
    )));
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
    setClassroomDelivery(false);
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

  // totalPagesCount is now handled inside calcPrice()
  const pagesStillDetecting = files.some((f) => f.pages === null && !f.estimated && !f.requiresConfirmation);
  const hasUnconfirmedPages = files.some((f) => f.pages === null || ((f.estimated || f.requiresConfirmation) && !f.pagesConfirmed));

  function calcPrice() {
    const printingSubtotal = files.reduce((sum, f) => sum + filePrintingCost(f), 0);

    // Delivery: Never charge both hostel and classroom delivery together.
    let deliveryCharge = 0;
    let deliveryType = 'none'; // 'classroom' | 'hostel' | 'none'
    if (classroomDelivery) {
      deliveryCharge = 5;
      deliveryType = 'classroom';
    } else if (selectedLocationId === 'hostel-gate') {
      deliveryCharge = 3;
      deliveryType = 'hostel';
    }

    // Binding remains available only for PDFs with the existing five-page minimum;
    // match the server's pricing predicate so retries/refreshes cannot change totals.
    const boundFileCount = files.filter((file) => file.spiralBinding && printablePages(file) >= 5).length;
    const bindingBaseCharge = boundFileCount * BINDING_CHARGE;
    const bindingServiceCharge = boundFileCount * BINDING_SERVICE_FEE;
    const bindingCharge = bindingBaseCharge + bindingServiceCharge;

    // Tiered Service Charge (Slabs)
    const totalPages = files.reduce((sum, f) => sum + (printablePages(f) * f.copies), 0);
    let serviceCharge = 0;
    if (totalPages > 0) {
      if (totalPages <= 10) serviceCharge = 1;
      else if (totalPages <= 30) serviceCharge = 2;
      else serviceCharge = 3;
    }

    return {
      pages: totalPages || 0,
      base: printingSubtotal || 0,
      a3Extra: 0,
      deliveryCharge,
      deliveryType,
      boundFileCount,
      bindingCharge,
      serviceCharge,
      total: (printingSubtotal || 0) + deliveryCharge + bindingCharge + serviceCharge
    };
  }

  const p = calcPrice();
  const serviceChargeRuleMissing = p.pages > 100;
  const hasFiles = files.length > 0;
  const filesMissingSettings = files.some(f => !hasCompleteFileSettings(f));

  function openBookingModal() {
    if (!hasFiles) { showToast('Please upload at least one file to continue.', 'error'); return; }
    if (serviceChargeRuleMissing) { showToast('Service-charge pricing above 100 billable pages is not configured. Please contact Campus Print.', 'error'); return; }
    if (pagesStillDetecting) { showToast('Still detecting page count — please wait a moment.', 'error'); return; }
    if (hasUnconfirmedPages) { showToast('Please enter and confirm the page count for all files.', 'error'); return; }
    if (filesMissingSettings) { showToast('Please choose printing settings for all files.', 'error'); return; }
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
    const isForward = (current, next) => {
      const order = { slot: 1, location: 2, payment: 3, review: 4 };
      return order[next] > order[current];
    };

    if (isForward(step, nextStep)) {
      if (nextStep === 'location' && !selectedTimeSlot) {
        showToast('Please select a time slot first.', 'error');
        return;
      }
      if (nextStep === 'payment' && (!selectedTimeSlot || !selectedLocationId)) {
        showToast('Please select both time slot and location.', 'error');
        return;
      }
      if (nextStep === 'review' && (!selectedTimeSlot || !selectedLocationId || !paymentMethod)) {
        showToast('Please complete all previous steps.', 'error');
        return;
      }
    }

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

    setPaymentOptionsLoading(false);
  }

  function collectionLocationName() {
    if (classroomDelivery) return academicBlockLocationName(true);
    if (selectedLocationId === ACADEMIC_BLOCK_ID) return academicBlockLocationName(false);
    return selectedLocationName;
  }

  function applyClassroomDelivery(enabled) {
    setClassroomDelivery(enabled);
    if (enabled) {
      setSelectedLocationId(ACADEMIC_BLOCK_ID);
      setSelectedLocationName(academicBlockLocationName(true));
      return;
    }
    if (selectedLocationId === ACADEMIC_BLOCK_ID) {
      setSelectedLocationName(academicBlockLocationName(false));
    }
  }

  function selectTimeSlot(time) {
    if (selectedTimeSlot === time) {
      setSelectedTimeSlot(null);
      setSelectedLocationId(null);
      setSelectedLocationName(null);
      return;
    }
    setSelectedTimeSlot(time);
    if (classroomDelivery && isLocationOffered(ACADEMIC_BLOCK_ID, time)) {
      setSelectedLocationId(ACADEMIC_BLOCK_ID);
      setSelectedLocationName(academicBlockLocationName(true));
      return;
    }
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
    if (classroomDelivery) {
      const academic = locationsData.find((loc) => loc.id === ACADEMIC_BLOCK_ID);
      const academicOpen = academic && academic.status !== 'unavailable' && academic.status !== 'past' && academic.status !== 'full';
      if (academicOpen) {
        setSelectedLocationId(ACADEMIC_BLOCK_ID);
        setSelectedLocationName(academicBlockLocationName(true));
      }
    }
  }

  function handleLocationSelect(locId, locName) {
    if (selectedLocationId === locId) {
      if (classroomDelivery && locId === ACADEMIC_BLOCK_ID) return;
      setSelectedLocationId(null);
      setSelectedLocationName(null);
      return;
    }
    if (selectedTimeSlot && !isLocationOffered(locId, selectedTimeSlot)) return;
    setSelectedLocationId(locId);
    if (locId === ACADEMIC_BLOCK_ID) {
      setSelectedLocationName(academicBlockLocationName(classroomDelivery));
    } else {
      setSelectedLocationName(locName);
      if (classroomDelivery) setClassroomDelivery(false);
    }
  }

  function buildOrderFormData() {
    const formData = new FormData();
    formData.append('paperSize', 'A4');
    formData.append('totalPages', p.pages);
    const totalCopies = files.reduce((sum, f) => sum + f.copies, 0);
    formData.append('copies', totalCopies);
    formData.append('spiralBinding', p.boundFileCount > 0);
    formData.append('expressDelivery', expressDelivery);
    formData.append('classroomDelivery', classroomDelivery);
    formData.append('totalPrice', p.total);
    formData.append('collectionLocationId', classroomDelivery ? ACADEMIC_BLOCK_ID : selectedLocationId);
    formData.append('collectionLocation', collectionLocationName());
    formData.append('collectionTime', selectedTimeSlot);

    // Guest Details
    formData.append('fullName', guestDetails?.fullName || '');
    formData.append('email', guestDetails?.email || currentUser?.email || '');
    formData.append('phone', guestDetails?.phone || '');
    formData.append('classroom', guestDetails?.classroom || '');

    // Per-file settings for backend verification and storage
    const fileSettings = buildFileSettingsPayload(files);
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
            // PAID but the ticket/token isn't ready yet.
            // We transition to 'received' to show the "Preparing your ticket..." UI.
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
    if (recoveryOrderId) {
      setPaying(true);
      try {
        const res = await fetch(`/api/orders/payment/status?orderId=${recoveryOrderId}`, {
          method: 'GET',
          credentials: 'include',
        });
        const statusData = await res.json().catch(() => ({}));

        if (res.ok && statusData.status === 'PAID') {
          showToast('This order is already paid. You can check your ticket on the Orders page.', 'info');
          setPaying(false);
          return;
        }

        if (res.ok && (statusData.status === 'FAILED' || statusData.status === 'EXPIRED')) {
          showToast('The previous payment failed or expired. You can safely retry now.', 'info');
          // Allow proceeding by not returning early
        } else if (!res.ok) {
          showToast('Could not verify previous payment status. Please try again later.', 'error');
          setPaying(false);
          return;
        } else {
          // Status is likely PAYMENT_PENDING or similar
          showToast('A payment attempt is still pending. Please check its status or wait before starting another order.', 'error');
          setPaying(false);
          return;
        }
      } catch (error) {
        showToast('Network error while verifying payment status. Please try again.', 'error');
        setPaying(false);
        return;
      }
    }
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
            selectedLocationName: collectionLocationName(),
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
        if (createData.cashfreeOrderId) {
          try {
            localStorage.setItem('cp_pending_payment', JSON.stringify({
              cashfreeOrderId: createData.cashfreeOrderId,
              createdAt: Date.now()
            }));
          } catch {
            // The current page still retains the order ID for reconciliation.
          }
          setRecoveryOrderId(createData.cashfreeOrderId);
          setPaymentMessage('Your order intent was saved, but checkout setup did not finish. Check payment status before trying again.');
        }
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
    setPaymentWarningOpen(true);
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

  let summaryNote = '';
  if (!hasFiles) summaryNote = 'Please upload at least one file to continue.';
  else if (pagesStillDetecting) summaryNote = 'Detecting page count…';
  else if (hasUnconfirmedPages) summaryNote = 'Please enter and confirm page count for all files.';
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
                  role="region"
                  aria-label="File upload"
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    id="fileInput"
                    multiple
                    accept={ACCEPT_ATTR}
                    onChange={(e) => { addFiles([...e.target.files]); e.target.value = ''; }}
                  />
                  <div className="upload-zone-icon-wrap" aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="17 8 12 3 7 8"></polyline>
                      <line x1="12" y1="3" x2="12" y2="15"></line>
                    </svg>
                  </div>
                  <h3 className="upload-zone-title">Upload your files</h3>
                  <p className="upload-zone-sub">Choose PDFs or documents from your device.</p>
                  <button
                    type="button"
                    className="upload-choose-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      fileInputRef.current?.click();
                    }}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                      <line x1="12" y1="18" x2="12" y2="12"></line>
                      <line x1="9" y1="15" x2="15" y2="15"></line>
                    </svg>
                    Choose PDFs
                  </button>
                  <p className="upload-zone-note">
                    Supports {SUPPORTED_LABEL}
                    <span className="upload-rec-tag">(PDF recommended)</span>
                    <span className="upload-info-tooltip-wrap" tabIndex="0" role="note" aria-label="Format recommendation details">
                      <span className="upload-info-icon" aria-hidden="true">i</span>
                      <span className="upload-info-tooltip-bubble" role="tooltip">
                        DOC/DOCX formatting, fonts, and spacing may change during conversion. For the most accurate layout and printing, convert your document to PDF before uploading.
                      </span>
                    </span>
                    {' '}· Max 20 MB each (up to 10 files)
                  </p>
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
                        if (f.pages === null && !f.estimated && !f.requiresConfirmation) {
                          pagesText = (
                            <span className="file-pages-detecting">
                              <span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2 }}></span> Detecting pages…
                            </span>
                          );
                        } else if (f.requiresConfirmation || f.estimated) {
                          pagesText = (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                              <span>Pages:</span>
                              <input
                                type="number" min="1" max="2000" value={f.pages ?? ''} placeholder="e.g. 5" aria-label={`Confirm page count for ${f.file.name}`}
                                onChange={(e) => updateFilePages(f.key, e.target.value)}
                                style={{ width: '4rem', padding: '0.15rem 0.35rem', border: '1px solid #ddd', borderRadius: '4px', fontSize: '0.8rem' }}
                              />
                              {f.pagesConfirmed && f.pages ? (
                                <span style={{ color: '#059669', fontSize: '0.8rem', fontWeight: 500 }}>(Manual count)</span>
                              ) : (
                                <span style={{ color: '#c2410c', fontSize: '0.8rem', fontWeight: 500 }}>(Please confirm document pages)</span>
                              )}
                            </span>
                          );
                        } else {
                          pagesText = `${f.pages} page${f.pages > 1 ? 's' : ''}`;
                        }
                        const pdfTotal = filePrintingCost(f);
                        return (
                          <div className="cp-file-card" key={f.key}>
                            {/* File Card Header */}
                            <div className="cp-file-header">
                              <div className="cp-file-icon-wrap" aria-hidden="true">
                                {isImageName(f.file.name) ? (
                                  <span className="cp-file-emoji">🖼️</span>
                                ) : (
                                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                                    <polyline points="14 2 14 8 20 8"></polyline>
                                    <line x1="16" y1="13" x2="8" y2="13"></line>
                                    <line x1="16" y1="17" x2="8" y2="17"></line>
                                    <polyline points="10 9 9 9 8 9"></polyline>
                                  </svg>
                                )}
                              </div>
                              <div className="cp-file-details">
                                <div className="cp-file-name" title={f.file.name}>{f.file.name}</div>
                                <div className="cp-file-meta">
                                  <span className="cp-file-badge">{typeLabel}</span>
                                  <span className="cp-file-meta-sep">·</span>
                                  <span>{formatSize(f.file.size)}</span>
                                  <span className="cp-file-meta-sep">·</span>
                                  <span>{pagesText}</span>
                                </div>
                              </div>
                              <button
                                type="button"
                                className="cp-file-remove-btn"
                                aria-label={`Remove ${f.file.name}`}
                                title="Remove document"
                                onClick={() => removeFile(f.key)}
                              >
                                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <polyline points="3 6 5 6 21 6"></polyline>
                                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                  <line x1="10" y1="11" x2="10" y2="17"></line>
                                  <line x1="14" y1="11" x2="14" y2="17"></line>
                                </svg>
                              </button>
                            </div>

                            {/* File Card Body */}
                            <div className="cp-file-body">
                              {/* Copies Row */}
                              <div className="cp-copies-row">
                                <span className="cp-field-label">Number of Copies:</span>
                                <div className="cp-stepper" role="group" aria-label="Copies">
                                  <button
                                    type="button"
                                    className="cp-stepper-btn"
                                    aria-label="Decrease copies"
                                    onClick={() => updateFileCopies(f.key, -1)}
                                  >
                                    −
                                  </button>
                                  <span className="cp-stepper-val" aria-live="polite">
                                    {f.copies ?? 1}
                                  </span>
                                  <button
                                    type="button"
                                    className="cp-stepper-btn"
                                    aria-label="Increase copies"
                                    onClick={() => updateFileCopies(f.key, 1)}
                                  >
                                    +
                                  </button>
                                </div>
                              </div>

                              {/* Print Mode Group */}
                              <div className="cp-setting-section">
                                <span className="cp-setting-title">Print Mode</span>
                                <div className="cp-options-grid" role="radiogroup" aria-label="Print Mode">
                                  <button
                                    type="button"
                                    role="radio"
                                    aria-checked={f.colorMode === 'bw'}
                                    className={`cp-option-card ${f.colorMode === 'bw' ? 'is-selected' : ''}`}
                                    onClick={() => updateFileColorMode(f.key, 'bw')}
                                  >
                                    <span className="cp-radio-circle" aria-hidden="true">
                                      <span className="cp-radio-dot" />
                                    </span>
                                    <div className="cp-option-text">
                                      <span className="cp-option-name">Black &amp; White</span>
                                      <span className="cp-option-price">₹2/page</span>
                                    </div>
                                  </button>

                                  <button
                                    type="button"
                                    role="radio"
                                    aria-checked={f.colorMode === 'color'}
                                    className={`cp-option-card ${f.colorMode === 'color' ? 'is-selected' : ''}`}
                                    onClick={() => updateFileColorMode(f.key, 'color')}
                                  >
                                    <span className="cp-radio-circle" aria-hidden="true">
                                      <span className="cp-radio-dot" />
                                    </span>
                                    <div className="cp-option-text">
                                      <span className="cp-option-name">Color</span>
                                      <span className="cp-option-price">{f.printingSide === 'double' ? '₹12/page' : '₹10/page'}</span>
                                    </div>
                                  </button>
                                </div>
                              </div>

                              {/* Print Sides Group */}
                              <div className="cp-setting-section">
                                <span className="cp-setting-title">Print Sides</span>
                                <div className="cp-options-grid" role="radiogroup" aria-label="Print Sides">
                                  <button
                                    type="button"
                                    role="radio"
                                    aria-checked={f.printingSide === 'single'}
                                    className={`cp-option-card ${f.printingSide === 'single' ? 'is-selected' : ''}`}
                                    onClick={() => updateFilePrintingSide(f.key, 'single')}
                                  >
                                    <span className="cp-radio-circle" aria-hidden="true">
                                      <span className="cp-radio-dot" />
                                    </span>
                                    <div className="cp-option-text">
                                      <span className="cp-option-name">Single Sided</span>
                                      <span className="cp-option-price">₹2/page</span>
                                    </div>
                                  </button>

                                  <button
                                    type="button"
                                    role="radio"
                                    aria-checked={f.printingSide === 'double'}
                                    className={`cp-option-card ${f.printingSide === 'double' ? 'is-selected' : ''}`}
                                    onClick={() => updateFilePrintingSide(f.key, 'double')}
                                  >
                                    <span className="cp-radio-circle" aria-hidden="true">
                                      <span className="cp-radio-dot" />
                                    </span>
                                    <div className="cp-option-text">
                                      <span className="cp-option-name">Double Sided</span>
                                      <span className="cp-option-price">₹3/page</span>
                                    </div>
                                  </button>
                                </div>
                              </div>

                              <div className="cp-setting-section">
                                <span className="cp-setting-title">Binding for this PDF</span>
                                <div className="cp-options-grid" role="radiogroup" aria-label={`Binding for ${f.file.name}`}>
                                  <button
                                    type="button"
                                    role="radio"
                                    aria-checked={!f.spiralBinding}
                                    className={`cp-option-card ${!f.spiralBinding ? 'is-selected' : ''}`}
                                    onClick={() => updateFileBinding(f.key, false)}
                                  >
                                    <span className="cp-radio-circle" aria-hidden="true"><span className="cp-radio-dot" /></span>
                                    <span className="cp-option-text">
                                      <span className="cp-option-name">No</span>
                                      <span className="cp-option-price">Free</span>
                                    </span>
                                  </button>
                                  <button
                                    type="button"
                                    role="radio"
                                    aria-checked={!!f.spiralBinding}
                                    className={`cp-option-card ${f.spiralBinding ? 'is-selected' : ''}`}
                                    onClick={() => updateFileBinding(f.key, true)}
                                  >
                                    <span className="cp-radio-circle" aria-hidden="true"><span className="cp-radio-dot" /></span>
                                    <span className="cp-option-text">
                                      <span className="cp-option-name">Yes</span>
                                      <span className="cp-option-price">₹25 + ₹1 fee</span>
                                    </span>
                                  </button>
                                </div>
                              </div>

                              {/* Page Range Input (when applicable) */}
                              {showPageRangeInput(f) && (
                                <div className="cp-page-range-section">
                                  <label htmlFor={`page-range-${f.key}`} className="cp-setting-title">
                                    Pages to print (optional)
                                  </label>
                                  <div className="cp-input-wrap">
                                    <input
                                      id={`page-range-${f.key}`}
                                      type="text"
                                      className={`cp-text-input ${rangeErr ? 'has-error' : ''}`}
                                      value={f.pageRange || ''}
                                      placeholder="e.g. 1-3, 5, 8-10"
                                      onChange={(e) => updateFilePageRange(f.key, e.target.value)}
                                      aria-invalid={!!rangeErr}
                                      aria-describedby={rangeErr ? `range-err-${f.key}` : `range-help-${f.key}`}
                                    />
                                  </div>
                                  <span id={`range-help-${f.key}`} className="cp-help-text">
                                    Leave empty to print all {f.pages} pages.
                                  </span>
                                  {rangeErr && (
                                    <span id={`range-err-${f.key}`} role="alert" className="cp-inline-error">
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

                              {/* File Subtotal Footer */}
                              <div className="cp-file-footer">
                                <span className="cp-file-footer-pages">
                                  {printablePages(f) * (f.copies || 1)} printed page{printablePages(f) * (f.copies || 1) !== 1 ? 's' : ''}
                                  {f.printingSide === 'double' ? ` (${Math.ceil(printablePages(f) / 2) * (f.copies || 1)} physical sheet${Math.ceil(printablePages(f) / 2) * (f.copies || 1) !== 1 ? 's' : ''})` : ''}
                                  {f.copies > 1 ? ` (${printablePages(f)} × ${f.copies} copies)` : ''}
                                </span>
                                <span className="cp-file-subtotal">
                                  File Total: <strong>₹{pdfTotal}</strong>
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <div style={{ marginTop: '0.75rem', textAlign: 'right' }}>
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

                <div className="cp-step2-grid">
                  <div className="cp-step2-group">
                    <span className="cp-setting-title">Paper Size</span>
                    <div className="cp-paper-size-pill">
                      <span className="cp-paper-badge">A4 Standard</span>
                      <span className="cp-paper-sub">210 × 297 mm</span>
                    </div>
                  </div>
                  <div className="setting-group">
                    <span className="setting-label">Classroom Delivery</span>
                    <div className="toggle-group" id="classroomDeliveryGroup">
                      <button className={toggleClass(!classroomDelivery)} onClick={() => applyClassroomDelivery(false)}>No (Free)</button>
                      <button className={toggleClass(classroomDelivery)} onClick={() => applyClassroomDelivery(true)}>Yes (+₹5)</button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Order Summary */}
            <div className="order-summary" aria-label="Order Summary">
              <h2 className="summary-title">Order Summary</h2>

              <div className="summary-lines">
                <div className="summary-line">
                  <span className="summary-line-label">Files Uploaded</span>
                  <span className="summary-line-value">{files.length} file{files.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="summary-line">
                  <span className="summary-line-label">Total Printed Pages</span>
                  <span className="summary-line-value">{p.pages} page{p.pages !== 1 ? 's' : ''}</span>
                </div>
                <div className="summary-line">
                  <span className="summary-line-label">Printing Charges</span>
                  <span className="summary-line-value">₹{p.base + p.a3Extra}</span>
                </div>
                <div className="summary-line">
                  <span className="summary-line-label">Service Charge</span>
                  <span className="summary-line-value">₹{p.serviceCharge}</span>
                </div>
                <div className="summary-line">
                  <span className="summary-line-label">
                    {p.boundFileCount > 0 ? `Binding — ₹26 (${p.boundFileCount} PDF${p.boundFileCount !== 1 ? 's' : ''})` : 'Binding'}
                  </span>
                  <span className="summary-line-value">
                    {p.boundFileCount > 0 ? `₹${p.bindingCharge}` : 'No — ₹0'}
                  </span>
                </div>
                <div className="summary-line">
                  <span className="summary-line-label">
                    {p.deliveryType === 'classroom'
                      ? 'Delivery Charge (Classroom)'
                      : p.deliveryType === 'hostel'
                      ? 'Delivery Charge (Hostel Gate)'
                      : 'Delivery Charge'}
                  </span>
                  <span className="summary-line-value">₹{p.deliveryCharge}</span>
                </div>
              </div>

              <div className="summary-divider"></div>

              <div className="summary-total">
                <span className="summary-total-label">Total Payable</span>
                <span className="summary-total-amount">₹{p.total}</span>
              </div>

              <button
                type="button"
                className="confirm-btn"
                disabled={!hasFiles || pagesStillDetecting || hasUnconfirmedPages || serviceChargeRuleMissing || files.some((f) => hasInvalidPageRange(f))}
                onClick={openBookingModal}
              >
                Continue to Order
              </button>
              {summaryNote && <p className="summary-note">{summaryNote}</p>}
              {serviceChargeRuleMissing && <p className="summary-note" role="alert">Service-charge pricing above 100 billable pages is not configured. Please contact Campus Print.</p>}
            </div>
          </div>

          {/* Mobile Sticky Bottom Summary Bar */}
          <aside className="cp-mobile-sticky-bar" aria-label="Order total and checkout">
            <div className="cp-mobile-sticky-content">
              <div className="cp-mobile-sticky-info">
                <div className="cp-mobile-sticky-total">
                  <span className="cp-mobile-sticky-label">Total:</span>
                  <span className="cp-mobile-sticky-amount">₹{p.total}</span>
                </div>
                <div className="cp-mobile-sticky-meta">
                  {files.length} file{files.length !== 1 ? 's' : ''} · {p.pages} page{p.pages !== 1 ? 's' : ''}
                  {p.deliveryCharge > 0 ? ` · +₹${p.deliveryCharge} del.` : ''}
                </div>
              </div>
              <button
                type="button"
                className="cp-mobile-sticky-btn"
                disabled={!hasFiles || pagesStillDetecting || hasUnconfirmedPages || serviceChargeRuleMissing || files.some((f) => hasInvalidPageRange(f))}
                onClick={openBookingModal}
              >
                Continue →
              </button>
            </div>
            {summaryNote && (
              <div className="cp-mobile-sticky-note" role="status">
                {summaryNote}
              </div>
            )}
          </aside>
        </main>
      </div>

      {/* Booking flow: Time → Location → Payment → Review */}
      <div className="booking-overlay" hidden={!modalOpen} onClick={(e) => { if (e.target === e.currentTarget) closeBookingModal(); }}>
        <div className="booking-panel booking-container" role="dialog" aria-modal="true">

          {/* ── Fixed header: close button + step navigation ── */}
          <div className="booking-panel-header">
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
          </div>

          {/* ── Scrollable body: active step content (no action buttons) ── */}
          <div className="booking-panel-body">

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
            </section>

            {/* Step 2: Location */}
            <section className={`cp-step-view cp-location-step`} hidden={step !== 'location'}>
              <div className="cp-view-header">
                <span className="location-tag">📍 Collection Point</span>
                <h2 className="location-title" style={{ marginTop: '0.5rem' }}>Where should we deliver your prints?</h2>
                <p className="location-subtitle">Pickup {preOrderMode ? 'tomorrow' : ''} at <strong style={{ color: 'var(--primary-blue-hover, #2563eb)' }}>{selectedTimeSlot || '—'}</strong>. Points not served at this time are unavailable.</p>
                {preOrderMode && (
                  <p className="location-subtitle" style={{ color: '#9a3412', fontWeight: 600 }}>📦 This is a pre-order — same-day booking for today is closed.</p>
                )}
                {classroomDelivery && (
                  <div style={{ background: '#eff6ff', border: '1px solid #93c5fd', borderRadius: '0.75rem', padding: '0.75rem 1rem', marginTop: '0.75rem', fontSize: '0.85rem', color: '#1e40af' }}>
                    {classroomDeliveryNoticeText(guestDetails?.classroom)}
                  </div>
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
                      <h3 className="cp-card-title">{locationOptionName(loc, classroomDelivery)}</h3>
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
                      const isSelected = paymentMethod === opt.id;
                      let classes = 'cp-loc-card cp-pay-card';
                      if (opt.recommended) classes += ' cp-pay-recommended';
                      if (isSelected) classes += ' is-selected';
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          role="radio"
                          aria-checked={isSelected}
                          className={classes}
                          onClick={() => {
                        if (paymentMethod === opt.id) {
                          setPaymentMethod(null);
                        } else {
                          setPaymentMethod(opt.id);
                        }
                      }}
                        >
                          <div className="cp-card-icon">
                            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{opt.icon}</svg>
                          </div>
                          <h3 className="cp-card-title">{opt.name}</h3>
                          {opt.badge && <span className="cp-pay-badge">{opt.badge}</span>}
                          <p className={`cp-pay-reliability cp-pay-reliability--${opt.tone}`}>{opt.reliability}</p>
                          <p className="cp-card-sub cp-pay-desc">{opt.description}</p>
                          <span className="cp-loc-status-tag">{isSelected ? 'Selected' : 'Available'}</span>
                        </button>
                      );
                    })}
                  </div>

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
                      <span>Name</span>
                      <strong>{guestDetails?.fullName || displayName || 'Not provided'}</strong>
                    </div>
                    <div className="cp-review-line">
                      <span>Delivery Option</span>
                      <strong>{collectionLocationName() || '—'}</strong>
                    </div>
                    {classroomDelivery && (
                      <div className="cp-review-line">
                        <span>Classroom Number</span>
                        <strong>{guestDetails?.classroom?.trim() || '—'}</strong>
                      </div>
                    )}
                    <div className="cp-review-line">
                      <span>Email</span>
                      <strong>{guestDetails?.email || currentUser?.email || '—'}</strong>
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
                      <strong className="cp-review-val">{collectionLocationName() || '—'}</strong>
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
                      <span>Printing Charges</span>
                      <strong>₹{p.base + p.a3Extra}</strong>
                    </div>
                    <div className="cp-review-line">
                      <span>Service Charge</span>
                      <strong>₹{p.serviceCharge}</strong>
                    </div>
                    <div className="cp-review-line">
                      <span>
                        {p.boundFileCount > 0 ? `Binding — ₹26 (${p.boundFileCount} PDF${p.boundFileCount !== 1 ? 's' : ''})` : 'Binding'}
                      </span>
                      <strong>{p.boundFileCount > 0 ? `₹${p.bindingCharge}` : 'No — ₹0'}</strong>
                    </div>
                    {files.some(f => f.spiralBinding && f.bindingDescription) && (
                      <div className="cp-review-line">
                        <span>Binding Instructions</span>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: '60%' }}>
                          {files.filter(f => f.spiralBinding && f.bindingDescription).map(f => (
                            <span key={f.key} style={{ fontSize: '0.8rem', textAlign: 'right' }}>
                              {files.length > 1 ? `${f.file.name}: ` : ''}{f.bindingDescription}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                    <div className="cp-review-line">
                      <span>
                        {p.deliveryType === 'classroom'
                          ? 'Delivery Charge (Classroom)'
                          : p.deliveryType === 'hostel'
                          ? 'Delivery Charge (Hostel Gate)'
                          : 'Delivery Charge'}
                      </span>
                      <strong>₹{p.deliveryCharge}</strong>
                    </div>
                  </div>
                  <div className="cp-review-total">
                    <span>Total Payable</span>
                    <strong>₹{p.total}</strong>
                  </div>
                </div>
              </div>
            </section>

          </div>{/* end booking-panel-body */}

          {/* ── Fixed footer: Back + Continue/Pay buttons for the active step ── */}
          <div className="booking-panel-footer">
            {step === 'slot' && (
              <div className="cp-step-footer space-between">
                <button type="button" className="btn btn-secondary" onClick={closeBookingModal}>← Back to Order</button>
                <button type="button" className="btn btn-primary" disabled={!selectedTimeSlot} onClick={() => goToStep('location')}>
                  Continue to Location <span className="arrow-icon">→</span>
                </button>
              </div>
            )}
            {step === 'location' && (
              <div className="cp-step-footer space-between">
                <button type="button" className="btn btn-secondary" onClick={() => goToStep('slot')}>← Back to Time Slot</button>
                <button type="button" className="btn btn-primary" disabled={!selectedLocationId} onClick={() => goToStep('payment')}>
                  Continue to Payment <span className="arrow-icon">→</span>
                </button>
              </div>
            )}
            {step === 'payment' && (
              <div className="cp-step-footer space-between">
                <button type="button" className="btn btn-secondary" onClick={() => goToStep('location')}>← Back to Location</button>
                <button type="button" className="btn btn-primary" disabled={!paymentMethod} onClick={() => goToStep('review')}>
                  Continue to Review <span className="arrow-icon">→</span>
                </button>
              </div>
            )}
            {step === 'review' && (
              <div className="cp-step-footer space-between">
                <button type="button" className="btn btn-secondary" onClick={() => goToStep('payment')}>← Back to Payment</button>
                <button type="button" className="btn btn-primary" disabled={paying} onClick={requestPayment}>
                  {paying ? (
                    <><span className="loading-spinner"></span>&nbsp; Processing…</>
                  ) : (
                    <>{paymentMethod === 'cashfree' ? 'Proceed to Payment' : paymentMethod === 'none' ? 'Order via WhatsApp' : 'Place Order'} <span className="arrow-icon">→</span></>
                  )}
                </button>
              </div>
            )}
          </div>{/* end booking-panel-footer */}

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

      

      {/* Payment confirmation modal for Cashfree */}
      {/* Payment confirmation modal for Cashfree */}
      {/* Payment confirmation modal for Cashfree */}
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
                <p style={{ color: '#6b7280', fontSize: '0.9rem', margin: '0 0 1.25rem' }}>Confirming your payment. This usually takes a few seconds.</p>
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
