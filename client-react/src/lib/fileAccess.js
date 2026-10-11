// Preview / download an order file through an authorized admin API route.
// The file is fetched with the admin's session cookie (the storage bucket stays
// private) and handed to the browser as a blob, so errors such as a deleted or
// missing file show as a readable message instead of a raw JSON page.

const PREVIEWABLE = /^(application\/pdf|image\/|text\/plain)/i;

/** Browsers can show PDFs, images and plain text inline; Office files must be downloaded. */
export function canPreview(mimeType) {
  return PREVIEWABLE.test(mimeType || '');
}

async function fetchFile(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `Could not load the file (error ${res.status}).`);
  }
  return res.blob();
}

/**
 * Opens the file in a new tab. Call directly from the click handler: the tab is
 * opened synchronously (so pop-up blockers allow it) and filled once the file arrives.
 */
export async function previewFile(url) {
  const tab = window.open('', '_blank');
  try {
    const blob = await fetchFile(url);
    const objectUrl = URL.createObjectURL(blob);
    if (tab) tab.location.href = objectUrl;
    else window.location.assign(objectUrl);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (error) {
    if (tab) tab.close();
    throw error;
  }
}

/** Downloads the file under its original name. */
export async function downloadFile(url, filename) {
  const separator = url.includes('?') ? '&' : '?';
  const blob = await fetchFile(`${url}${separator}download=1`);
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename || 'file';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
