// Delivery contacts shown on paid collection tickets — the ONE place to edit them.
import slotMatrix from './slotMatrix.json';

export const DELIVERY_PERSONS = {
  // Academic Block (incl. classroom delivery)
  academicBlock: {
    name: 'Tejasv Tyagi',
    phone: '8287925992',
  },

  // Main Gate
  mainGate: {
    name: 'Atishay Jain',
    phone: '9411840651',
  },

  // Red Canteen and Hostel Gate
  hostelAndCanteen: {
    name: 'Ankit Chaurasia',
    phone: '8076756723',
  },
};

// Keys are the location ids from lib/slotMatrix.json (stored on each order as collection_location_id).
export const LOCATION_DELIVERY_MAP = {
  'academic-block': 'academicBlock',
  'red-canteen': 'hostelAndCanteen',
  'main-gate': 'mainGate',
  'hostel-gate': 'hostelAndCanteen',
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
  const normalizedName = (locationName || '').trim().toLowerCase();
  const id = locationId || slotMatrix.locations.find((loc) => 
    loc.name.toLowerCase() === normalizedName ||
    loc.id.toLowerCase() === normalizedName
  )?.id;
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