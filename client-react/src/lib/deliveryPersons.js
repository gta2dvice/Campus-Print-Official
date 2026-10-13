// Delivery contacts shown on paid collection tickets — the ONE place to edit them.
//
// Replace each ADD_... placeholder with the real name and phone number.
// Phone: a 10-digit Indian mobile number, e.g. "9876543210" ("+91 98765 43210" also works).
// Until a real name AND a valid phone are entered, the ticket shows
// "Delivery contact unavailable" instead of a placeholder.
import slotMatrix from './slotMatrix.json';

export const DELIVERY_PERSONS = {
  // Delivery Person 1 — Academic Block (incl. classroom delivery) and Red Canteen
  academicBlock: {
    name: 'Tejasv',
    phone: 'ADD_ACADEMIC_BLOCK_DELIVERY_PHONE',
  },

  // Delivery Person 2 — Main Gate
  mainGate: {
    name: 'Atishay',
    phone: 'ADD_MAIN_GATE_DELIVERY_PHONE',
  },

  // Delivery Person 3 — Hostel Gate
  hostelGate: {
    name: 'Ankit',
    phone: 'ADD_HOSTEL_GATE_DELIVERY_PHONE',
  },
};

// Keys are the location ids from lib/slotMatrix.json (stored on each order as collection_location_id).
export const LOCATION_DELIVERY_MAP = {
  'academic-block': 'academicBlock',
  'red-canteen': 'academicBlock',
  'main-gate': 'mainGate',
  'hostel-gate': 'hostelGate',
};

// 10-digit Indian mobile (accepts +91 / 0 prefixes and spaces), or null if invalid.
function normalizeIndianMobile(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  let mobile = digits;
  if (digits.length === 12 && digits.startsWith('91')) mobile = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) mobile = digits.slice(1);
  return /^[6-9]\d{9}$/.test(mobile) ? mobile : null;
}

/**
 * Delivery contact for an order's collection location, or null when the location
 * is unknown or the contact still has a placeholder / invalid phone.
 * Falls back to matching the location name for orders saved without an id.
 */
export function getDeliveryContact(locationId, locationName) {
  const id = locationId || slotMatrix.locations.find((loc) => loc.name === locationName)?.id;
  const person = DELIVERY_PERSONS[LOCATION_DELIVERY_MAP[id]];
  if (!person) return null;

  const name = typeof person.name === 'string' ? person.name.trim() : '';
  const phone = normalizeIndianMobile(person.phone);
  if (!name || name.startsWith('ADD_') || !phone) return null;

  return {
    name,
    phoneDisplay: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`,
    telHref: `tel:+91${phone}`,
  };
}
