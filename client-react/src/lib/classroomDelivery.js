export const ACADEMIC_BLOCK_ID = 'academic-block';
export const ACADEMIC_BLOCK_NAME = 'Academic Block';
export const ACADEMIC_BLOCK_CLASSROOM_NAME = 'Academic Block - Classroom Delivery';
export const CLASSROOM_DELIVERY_CHARGE = 5;

export function isClassroomDeliveryEnabled(value) {
  return value === true || value === 'true';
}

export function academicBlockLocationName(classroomDelivery) {
  return isClassroomDeliveryEnabled(classroomDelivery)
    ? ACADEMIC_BLOCK_CLASSROOM_NAME
    : ACADEMIC_BLOCK_NAME;
}

export function locationOptionName(location, classroomDelivery) {
  if (location?.id === ACADEMIC_BLOCK_ID) {
    return academicBlockLocationName(classroomDelivery);
  }
  return location?.name || '';
}

export function classroomDeliveryNoticeText(classroomNumber) {
  const room = String(classroomNumber || '').trim();
  if (room) {
    return `Classroom delivery selected for classroom no. ${room}. Additional charge: ₹${CLASSROOM_DELIVERY_CHARGE}.`;
  }
  return `Classroom delivery selected. Additional charge: ₹${CLASSROOM_DELIVERY_CHARGE}.`;
}

export function isClassroomDeliveryOrder(order) {
  if (!order) return false;
  if (isClassroomDeliveryEnabled(order.classroom_delivery)) return true;
  if (Number(order.classroom_charge) > 0) return true;
  const loc = String(order.collection_location || '');
  return loc === ACADEMIC_BLOCK_CLASSROOM_NAME || /classroom delivery/i.test(loc);
}
