export const pendingOrderStore = {
  files: [],
  color: 'bw',
  size: 'A4',
  printingSide: 'single',
};

export function setPendingOrder(data) {
  Object.assign(pendingOrderStore, data);
}

export function clearPendingOrder() {
  pendingOrderStore.files = [];
  pendingOrderStore.color = 'bw';
  pendingOrderStore.size = 'A4';
  pendingOrderStore.printingSide = 'single';
}
