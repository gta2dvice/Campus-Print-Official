// Client-side view of the time ↔ location availability matrix.
// slotMatrix.json is the single source of truth — server/slots.js reads the same file.
// To add or change a slot, edit only slotMatrix.json.
import matrix from './slotMatrix.json';

export const SLOT_LOCATIONS = matrix.locations;
export const TIME_SLOTS = Object.keys(matrix.availability);
const DISABLED_TIME_SLOTS = ['11:15 AM', '1:15 PM'];

export function isLocationOffered(locationId, time) {
  if (DISABLED_TIME_SLOTS.includes(time)) return false;
  return matrix.availability[time]?.[locationId] === true;
}

export function offeredLocationIds(time) {
  return SLOT_LOCATIONS.filter((loc) => isLocationOffered(loc.id, time)).map((loc) => loc.id);
}

export function offeredTimes(locationId) {
  return TIME_SLOTS.filter((time) => isLocationOffered(locationId, time));
}
