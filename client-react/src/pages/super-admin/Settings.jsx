import { useState } from 'react';
import Toast from '../../components/Toast';
import useToast from './useToast';
import { saApi } from './shared';

export default function Settings() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, showToast] = useToast();

  async function handleSubmit(e) {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      showToast('New passwords do not match.', 'error');
      return;
    }
    setSubmitting(true);
    try {
      const res = await saApi('/api/super-admin/account/password', {
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
    <>
      <div className="max-w-[560px] rounded-[18px] border border-gray-300/50 bg-white/90 p-6 max-sm:p-4 shadow-sm backdrop-blur-md">
        <h2 className="mb-[1.1rem] text-base font-bold text-gray-900">Account Settings</h2>
        <form onSubmit={handleSubmit}>
          <div className="mb-4 flex flex-col gap-[0.4rem] text-[0.85rem] font-medium text-gray-600">
            <label>Current Password</label>
            <input
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500 max-sm:min-h-11 max-sm:text-base"
            />
          </div>
          <div className="mb-4 flex flex-col gap-[0.4rem] text-[0.85rem] font-medium text-gray-600">
            <label>New Password</label>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500 max-sm:min-h-11 max-sm:text-base"
            />
          </div>
          <div className="mb-4 flex flex-col gap-[0.4rem] text-[0.85rem] font-medium text-gray-600">
            <label>Confirm New Password</label>
            <input
              type="password"
              autoComplete="new-password"
              minLength={8}
              required
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="rounded-[10px] border border-gray-200 bg-white px-[0.8rem] py-[0.55rem] text-[0.85rem] text-gray-900 outline-none focus:border-blue-500 max-sm:min-h-11 max-sm:text-base"
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-full bg-blue-500 px-[1.1rem] py-2 text-[0.85rem] font-semibold text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60 max-sm:min-h-11 max-sm:w-full"
          >
            Update Password
          </button>
        </form>
      </div>
      <Toast toast={toast} />
    </>
  );
}
