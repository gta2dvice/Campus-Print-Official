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

// Minimal viewer document written into the preview tab. The blob URL is embedded
// directly (PDF viewer / image / iframe), so the tab renders the fetched bytes even
// when bare blob-URL navigation is blocked by the browser.
function viewerHtml(objectUrl, mimeType) {
  const type = String(mimeType || '');
  let body;
  if (/^application\/pdf/i.test(type)) {
    body = `<embed src="${objectUrl}" type="application/pdf" style="width:100%;height:100%">`;
  } else if (/^image\//i.test(type)) {
    body = `<img src="${objectUrl}" style="max-width:95vw;max-height:95vh;display:block;margin:auto">`;
  } else {
    body = `<iframe src="${objectUrl}" style="width:100%;height:100%;border:0;background:#fff"></iframe>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>File preview</title>
<style>html,body{margin:0;height:100%;background:#525659}body{display:flex;align-items:stretch;justify-content:stretch}</style>
</head><body>${body}</body></html>`;
}

function errorHtml(message) {
  const safe = String(message || 'Could not load this file.').replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return `<!doctype html><html><head><meta charset="utf-8"><title>Preview failed</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc;color:#334155}div{text-align:center;max-width:32rem;padding:1rem}</style>
</head><body><div><h3>Preview unavailable</h3><p>${safe}</p></div></body></html>`;
}

function writeToTab(tab, html) {
  if (!tab) return false;
  try {
    tab.document.write(html);
    tab.document.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens the file in a new tab. Call directly from the click handler: the tab is
 * opened synchronously (so pop-up blockers allow it) and filled once the file arrives.
 * The tab shows a loading state, then the rendered file or a readable error — it
 * never stays stuck on a blank page.
 */
export async function previewFile(url) {
  const tab = window.open('', '_blank');
  writeToTab(tab, '<!doctype html><title>Loading…</title><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,sans-serif;color:#64748b">Loading preview…</body>');
  try {
    const blob = await fetchFile(url);
    const objectUrl = URL.createObjectURL(blob);
    if (!writeToTab(tab, viewerHtml(objectUrl, blob.type))) {
      // Fallback for browsers that forbid document.write on the new tab.
      if (tab) tab.location.href = objectUrl;
      else window.location.assign(objectUrl);
    }
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch (error) {
    if (!writeToTab(tab, errorHtml(error?.message))) {
      if (tab) tab.close();
    }
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
