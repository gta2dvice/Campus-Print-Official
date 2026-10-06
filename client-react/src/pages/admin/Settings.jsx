import { useState } from 'react';
import Toast from '../../components/Toast';
import { adminApi } from '../../lib/adminHelpers';
import '../../styles/admin-effects.css';

export default function Settings() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [toast, setToast] = useState(null);
  function showToast(message, type = 'success') {
    setToast({ message, type, show: true });
    setTimeout(() => setToast((t) => t && { ...t, show: false }), 3500);
  }

  async function handleSubmit(e) {
    e.preventDefault();

    if (newPassword !== confirmPassword) {
      showToast('New passwords do not match.', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const res = await adminApi('/api/admin/account/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) { showToast(data.message || 'Update failed', 'error'); return; }
      showToast('Password updated successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch {
      showToast('Connection error. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-xl space-y-6">
      <div className="admin-card">
        <div className="border-b border-slate-100 pb-4">
          <h3 className="text-lg font-black text-slate-900">Security & Account Settings</h3>
          <p className="text-xs text-slate-500 font-medium">Update your shop admin password and security credentials</p>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          <label className="block space-y-1.5 text-xs font-bold text-slate-700">
            <span>Current Password</span>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="admin-input"
            />
          </label>
          <label className="block space-y-1.5 text-xs font-bold text-slate-700">
            <span>New Password</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="admin-input"
            />
          </label>
          <label className="block space-y-1.5 text-xs font-bold text-slate-700">
            <span>Confirm New Password</span>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="admin-input"
            />
          </label>

          <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-3.5 text-xs text-blue-900 font-medium">
            🔒 Password requirement: Minimum 8 characters. Must contain at least one number or special character.
          </div>

          <div className="pt-2 flex justify-end">
            <button
              type="submit"
              disabled={submitting}
              className="admin-btn-primary max-sm:w-full"
            >
              {submitting ? 'Updating Password…' : 'Update Password'}
            </button>
          </div>
        </form>
      </div>
      <Toast toast={toast} />
    </div>
  );
}
