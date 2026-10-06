import { useEffect, useRef, useState } from 'react';
import Toast from '../../components/Toast';
import { adminApi } from '../../lib/adminHelpers';
import '../../styles/admin-effects.css';

export default function ShopProfile() {
  const [form, setForm] = useState({
    shop_name: '', owner_name: '', phone: '', email: '', address: '',
    opens_at: '', closes_at: '', is_open: false,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [qrPath, setQrPath] = useState(null); // storage path; changes on every upload, so it also busts the preview cache
  const [qrUploading, setQrUploading] = useState(false);
  const qrInputRef = useRef(null);

  const [toast, setToast] = useState(null);
  function showToast(message, type = 'success') {
    setToast({ message, type, show: true });
    setTimeout(() => setToast((t) => t && { ...t, show: false }), 3500);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await adminApi('/api/admin/shop-profile');
        if (!res.ok) throw new Error('Failed to load shop profile');
        const p = await res.json();
        if (cancelled) return;
        setForm({
          shop_name: p.shop_name || '',
          owner_name: p.owner_name || '',
          phone: p.phone || '',
          email: p.email || '',
          address: p.address || '',
          opens_at: p.opens_at || '',
          closes_at: p.closes_at || '',
          is_open: !!p.is_open,
        });
        setQrPath(p.payment_qr_path || null);
      } catch {
        if (!cancelled) showToast('Could not load shop profile.', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  async function handleQrUpload(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      showToast('Upload a PNG, JPG or WEBP image.', 'error');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast('QR image must be 5 MB or smaller.', 'error');
      return;
    }
    setQrUploading(true);
    try {
      const body = new FormData();
      body.append('qr', file);
      // Empty headers so the browser sets the multipart boundary.
      const res = await adminApi('/api/admin/shop-profile/payment-qr', { method: 'POST', headers: {}, body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(data.message || 'Upload failed', 'error');
        return;
      }
      setQrPath(data.payment_qr_path || null);
      showToast('Payment QR updated.');
    } catch {
      showToast('Connection error. Please try again.', 'error');
    } finally {
      setQrUploading(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await adminApi('/api/admin/shop-profile', {
        method: 'PUT',
        body: JSON.stringify({
          shop_name: form.shop_name.trim(),
          owner_name: form.owner_name.trim(),
          phone: form.phone.trim(),
          email: form.email.trim(),
          address: form.address.trim(),
          opens_at: form.opens_at || null,
          closes_at: form.closes_at || null,
          is_open: form.is_open,
        }),
      });
      if (!res.ok) {
        const data = await res.json();
        showToast(data.message || 'Save failed', 'error');
        return;
      }
      showToast('Shop profile updated successfully.');
    } catch {
      showToast('Connection error. Please try again.', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="admin-card">
        <div className="border-b border-slate-100 pb-4">
          <h3 className="text-lg font-black text-slate-900">Shop Profile & Operating Hours</h3>
          <p className="text-xs text-slate-500 font-medium">Manage shop details, campus pickup location, and live store availability</p>
        </div>

        {loading ? (
          <div className="py-12 text-center text-xs font-semibold text-slate-400">Loading shop details...</div>
        ) : (
          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <label className="block space-y-1.5 text-xs font-bold text-slate-700">
                <span>Shop Name</span>
                <input type="text" value={form.shop_name} onChange={(e) => update('shop_name', e.target.value)} className="admin-input" />
              </label>
              <label className="block space-y-1.5 text-xs font-bold text-slate-700">
                <span>Owner Name</span>
                <input type="text" value={form.owner_name} onChange={(e) => update('owner_name', e.target.value)} className="admin-input" />
              </label>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              <label className="block space-y-1.5 text-xs font-bold text-slate-700">
                <span>Phone Number</span>
                <input type="text" value={form.phone} onChange={(e) => update('phone', e.target.value)} className="admin-input" />
              </label>
              <label className="block space-y-1.5 text-xs font-bold text-slate-700">
                <span>Contact Email</span>
                <input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} className="admin-input" />
              </label>
            </div>

            <label className="block space-y-1.5 text-xs font-bold text-slate-700">
              <span>Campus Pickup Location / Address</span>
              <textarea rows={2} value={form.address} onChange={(e) => update('address', e.target.value)} className="admin-input" />
            </label>

            <div className="grid grid-cols-2 gap-4 rounded-2xl border border-slate-100 bg-slate-50/50 p-4 max-[360px]:grid-cols-1">
              <label className="block space-y-1.5 text-xs font-bold text-slate-700">
                <span>Opening Time</span>
                <input type="time" value={form.opens_at} onChange={(e) => update('opens_at', e.target.value)} className="admin-date-input w-full" />
              </label>
              <label className="block space-y-1.5 text-xs font-bold text-slate-700">
                <span>Closing Time</span>
                <input type="time" value={form.closes_at} onChange={(e) => update('closes_at', e.target.value)} className="admin-date-input w-full" />
              </label>
            </div>

            {/* Live Store Switch */}
            <div className="flex items-center justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <div>
                <div className="text-xs font-extrabold text-slate-900">Store Acceptance Status</div>
                <div className="text-[0.68rem] text-slate-500 font-medium">Toggle whether your shop accepts new student print orders right now</div>
              </div>
              <label className="relative inline-flex flex-shrink-0 cursor-pointer items-center">
                <input
                  type="checkbox"
                  checked={form.is_open}
                  onChange={(e) => update('is_open', e.target.checked)}
                  className="peer sr-only"
                />
                <div className="peer h-6 w-11 rounded-full bg-slate-300 transition-colors after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-all after:content-[''] peer-checked:bg-emerald-500 peer-checked:after:translate-x-full peer-focus:outline-none" />
              </label>
            </div>

            <div className="pt-2 flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="admin-btn-primary max-sm:w-full"
              >
                {saving ? 'Saving Changes…' : 'Save Profile Changes'}
              </button>
            </div>
          </form>
        )}
      </div>

      <div className="admin-card">
        <div className="border-b border-slate-100 pb-4">
          <h3 className="text-lg font-black text-slate-900">WhatsApp / UPI Payment QR</h3>
          <p className="text-xs text-slate-500 font-medium">Students see this QR when they choose WhatsApp Payment. The phone number above is shown when they choose No Payment.</p>
        </div>

        {loading ? (
          <div className="py-12 text-center text-xs font-semibold text-slate-400">Loading...</div>
        ) : (
          <div className="mt-6 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
            <div className="flex h-48 w-48 flex-shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-white p-2">
              {qrPath ? (
                <img
                  src={`/api/admin/shop-profile/payment-qr?v=${encodeURIComponent(qrPath.split('/').pop())}`}
                  alt="Current payment QR"
                  className="h-full w-full object-contain"
                />
              ) : (
                <span className="px-4 text-center text-xs font-semibold text-slate-400">No QR uploaded. WhatsApp Payment is hidden from students.</span>
              )}
            </div>
            <div className="w-full space-y-3 text-center sm:text-left">
              <p className="text-xs text-slate-600 font-medium">PNG, JPG or WEBP, up to 5 MB. Uploading a new image replaces the current QR.</p>
              <input ref={qrInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleQrUpload} />
              <button
                type="button"
                disabled={qrUploading}
                onClick={() => qrInputRef.current?.click()}
                className="admin-btn-primary max-sm:w-full"
              >
                {qrUploading ? 'Uploading…' : (qrPath ? 'Replace QR Image' : 'Upload QR Image')}
              </button>
            </div>
          </div>
        )}
      </div>
      <Toast toast={toast} />
    </div>
  );
}
