// Time ↔ location availability matrix — single source of truth shared with the client
// (client-react/src/lib/slotMatrix.json). To add or change a slot, edit only that file.
const SLOT_MATRIX = require('../client-react/src/lib/slotMatrix.json');

const LOCATIONS = SLOT_MATRIX.locations;

const TIME_SLOTS = Object.keys(SLOT_MATRIX.availability);

/** Location ids offered at each slot, derived from the matrix. */
const OFFERED_BY_TIME = Object.fromEntries(
    TIME_SLOTS.map(time => [
        time,
        LOCATIONS.filter(loc => SLOT_MATRIX.availability[time][loc.id] === true).map(loc => loc.id)
    ])
);

const SLOT_CAPACITY = 6;
const SLOT_CUTOFF_MINUTES = 5;
// When false: ignore IST cutoff and live booking counts (full/limited).
// Locations still follow OFFERED_BY_TIME. Set true to restore real availability.
const LIVE_SLOT_AVAILABILITY = true;
// 5:00 PM IST — once reached, same-day booking is closed and the next day opens for pre-order.
const NEXT_DAY_SWITCH_MINUTES = 17 * 60;

/** Baseline occupancy so availability differs per location + slot. */
const SEED_BOOKED = {};

function getLocationById(id) {
    return LOCATIONS.find(loc => loc.id === id) || null;
}

function getLocationByName(name) {
    return LOCATIONS.find(loc => loc.name === name) || null;
}

function slotKey(locationId, timeSlot) {
    return `${locationId}|${timeSlot}`;
}

function offeredLocationIds(time) {
    return OFFERED_BY_TIME[time] || [];
}

function isLocationOffered(locationId, time) {
    return offeredLocationIds(time).includes(locationId);
}

function statusFromBooked(booked, capacity = SLOT_CAPACITY) {
    if (booked >= capacity) return 'full';
    if (booked >= Math.ceil(capacity * 0.7)) return 'limited';
    return 'available';
}

// Campus Print only operates in India, so "now" for slot cutoffs is always IST — regardless of
// what timezone the server process/host happens to be configured with. Comparing minutes-since-
// midnight (instead of Date objects built from the OS's local timezone) keeps this correct no
// matter where the Node process actually runs.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Minutes since midnight IST, right now. */
function nowMinutesIST(atMs = Date.now()) {
    const istMs = atMs + IST_OFFSET_MS;
    return Math.floor((istMs % 86400000) / 60000);
}

/** True once it's past the 5:00 PM IST cutover — same-day slots are closed, tomorrow opens for pre-order. */
function isPreOrderMode(atMs = Date.now()) {
    if (!LIVE_SLOT_AVAILABILITY) return false;
    return nowMinutesIST(atMs) >= NEXT_DAY_SWITCH_MINUTES;
}

/** IST calendar date (YYYY-MM-DD), optionally offset by whole days. */
function istDateString(atMs = Date.now(), dayOffset = 0) {
    const shifted = new Date(atMs + IST_OFFSET_MS + dayOffset * 86400000);
    const y = shifted.getUTCFullYear();
    const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const d = String(shifted.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/** Which calendar day (IST) a new order placed right now is actually for. */
function getOrderDateContext(atMs = Date.now()) {
    const preOrder = isPreOrderMode(atMs);
    return { preOrder, date: istDateString(atMs, preOrder ? 1 : 0) };
}

/** Parses a "9:25 AM" style label into minutes since midnight. */
function slotMinutes(time) {
    const match = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(time.trim());
    if (!match) return null;
    let [, hourStr, minStr, meridiem] = match;
    let hour = parseInt(hourStr, 10) % 12;
    if (meridiem.toUpperCase() === 'PM') hour += 12;
    return hour * 60 + parseInt(minStr, 10);
}

/** Slot is closed from SLOT_CUTOFF_MINUTES before the labeled time (IST). */
function isSlotPast(time, atMs = Date.now()) {
    if (!LIVE_SLOT_AVAILABILITY) return false;
    if (isPreOrderMode(atMs)) return false; // these are tomorrow's slots — never "past" relative to today's clock
    const mins = slotMinutes(time);
    if (mins === null) return true;
    return nowMinutesIST(atMs) >= mins - SLOT_CUTOFF_MINUTES;
}

function pickupError(locationId, time, atMs = Date.now()) {
    if (!TIME_SLOTS.includes(time)) return 'Unknown collection time';
    if (!getLocationById(locationId)) return 'Unknown collection location';
    if (isSlotPast(time, atMs)) return 'This time slot is no longer available.';
    if (!isLocationOffered(locationId, time)) return 'This location is not available for the selected time.';
    return null;
}

function buildTimeSlotStatuses(atMs = Date.now()) {
    return TIME_SLOTS.map(time => {
        const isPast = isSlotPast(time, atMs);
        return {
            time,
            status: isPast ? 'past' : 'available',
            isPast,
            offeredLocationIds: offeredLocationIds(time)
        };
    });
}

function buildLocationStatusesForTime(time, countsByLocationId = {}, atMs = Date.now()) {
    const past = isSlotPast(time, atMs);
    return LOCATIONS.map(loc => {
        const offered = isLocationOffered(loc.id, time);
        if (!offered) {
            return {
                id: loc.id,
                name: loc.name,
                hint: loc.hint,
                status: 'unavailable',
                offered: false,
                booked: 0,
                capacity: SLOT_CAPACITY
            };
        }
        if (past) {
            return {
                id: loc.id,
                name: loc.name,
                hint: loc.hint,
                status: 'past',
                offered: true,
                booked: 0,
                capacity: SLOT_CAPACITY
            };
        }
        if (!LIVE_SLOT_AVAILABILITY) {
            return {
                id: loc.id,
                name: loc.name,
                hint: loc.hint,
                status: 'available',
                offered: true,
                booked: 0,
                capacity: SLOT_CAPACITY
            };
        }
        const seed = SEED_BOOKED[slotKey(loc.id, time)] || 0;
        const live = countsByLocationId[loc.id] || 0;
        const booked = Math.min(SLOT_CAPACITY, seed + live);
        return {
            id: loc.id,
            name: loc.name,
            hint: loc.hint,
            status: statusFromBooked(booked),
            offered: true,
            booked,
            capacity: SLOT_CAPACITY,
            remaining: Math.max(0, SLOT_CAPACITY - booked)
        };
    });
}

function buildSlotStatuses(locationId, countsByTime = {}, atMs = Date.now()) {
    return TIME_SLOTS.map(time => {
        const offered = isLocationOffered(locationId, time);
        const isPast = isSlotPast(time, atMs);
        if (!offered) {
            return {
                time,
                status: 'unavailable',
                isPast: false,
                booked: 0,
                capacity: SLOT_CAPACITY,
                remaining: 0
            };
        }
        if (!LIVE_SLOT_AVAILABILITY) {
            return {
                time,
                status: isPast ? 'past' : 'available',
                isPast,
                booked: 0,
                capacity: SLOT_CAPACITY,
                remaining: SLOT_CAPACITY
            };
        }
        const seed = SEED_BOOKED[slotKey(locationId, time)] || 0;
        const live = countsByTime[time] || 0;
        const booked = Math.min(SLOT_CAPACITY, seed + live);
        const status = isPast ? 'past' : statusFromBooked(booked);
        return {
            time,
            status,
            isPast,
            booked,
            capacity: SLOT_CAPACITY,
            remaining: Math.max(0, SLOT_CAPACITY - booked)
        };
    });
}

module.exports = {
    LOCATIONS,
    TIME_SLOTS,
    SLOT_CAPACITY,
    SLOT_CUTOFF_MINUTES,
    LIVE_SLOT_AVAILABILITY,
    NEXT_DAY_SWITCH_MINUTES,
    OFFERED_BY_TIME,
    getLocationById,
    getLocationByName,
    nowMinutesIST,
    slotMinutes,
    isSlotPast,
    isPreOrderMode,
    istDateString,
    getOrderDateContext,
    isLocationOffered,
    pickupError,
    buildTimeSlotStatuses,
    buildLocationStatusesForTime,
    buildSlotStatuses
};
