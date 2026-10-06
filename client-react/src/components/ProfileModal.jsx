import { useEffect, useMemo, useState } from 'react';

const EMPTY = { full_name: '', phone_number: '', class_room_number: '' };

function validateFields(form) {
  const errors = {};
  const name = form.full_name.trim();
  const phone = form.phone_number.replace(/\s+/g, '');
  const room = form.class_room_number.trim();

  if (!name) errors.full_name = 'Enter your full name.';
  else if (name.length < 2) errors.full_name = 'Name must be at least 2 characters.';

  if (!phone) errors.phone_number = 'Enter your phone number.';
  else if (!/^\d{10}$/.test(phone)) errors.phone_number = 'Enter a valid 10-digit phone number.';

  if (!room) errors.class_room_number = 'Enter your class or room number.';

  return errors;
}

function completionPercent(form) {
  const errors = validateFields(form);
  let filled = 0;
  if (!errors.full_name && form.full_name.trim()) filled += 1;
  if (!errors.phone_number && form.phone_number.trim()) filled += 1;
  if (!errors.class_room_number && form.class_room_number.trim()) filled += 1;
  return Math.round((filled / 3) * 100);
}

export default function ProfileModal({
  open,
  mode = 'complete',
  initialValues,
  required = false,
  onClose,
  onSaved,
}) {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    if (!open) {
      setJustSaved(false);
      setSaving(false);
      return;
    }
    setForm({
      full_name: initialValues?.full_name || '',
      phone_number: initialValues?.phone_number || '',
      class_room_number: initialValues?.class_room_number || '',
    });
    setErrors({});
    setServerError('');
    setJustSaved(false);
    // Snapshot values only when the modal opens so a parent re-render cannot reset typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    document.body.classList.add('modal-open');
    return () => document.body.classList.remove('modal-open');
  }, [open]);

  const percent = useMemo(() => completionPercent(form), [form]);
  const fieldErrors = useMemo(() => validateFields(form), [form]);
  const isValid = Object.keys(fieldErrors).length === 0;

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
    setServerError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    const nextErrors = validateFields(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setSaving(true);
    setServerError('');
    try {
      const payload = {
        full_name: form.full_name.trim(),
        phone_number: form.phone_number.replace(/\s+/g, ''),
        class_room_number: form.class_room_number.trim(),
      };
      const res = await fetch('/api/auth/profile', {
        method: mode === 'edit' ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (mode === 'complete' && res.status === 400 && /already exists/i.test(data.message || '')) {
          const retry = await fetch('/api/auth/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload),
          });
          const retryData = await retry.json().catch(() => ({}));
          if (!retry.ok) {
            setServerError(retryData.message || 'Failed to save profile');
            return;
          }
          setJustSaved(true);
          window.setTimeout(() => {
            onSaved?.(retryData.full_name ? retryData : payload);
          }, 450);
          return;
        }
        setServerError(data.message || 'Failed to save profile');
        return;
      }
      setJustSaved(true);
      window.setTimeout(() => {
        onSaved?.(data.full_name ? data : payload);
      }, 450);
    } catch {
      setServerError('An unexpected error occurred. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const isCompleteMode = mode === 'complete';
  const title = isCompleteMode ? 'Complete Your Profile 👋' : 'Edit Profile';
  const subtitle = isCompleteMode
    ? 'Complete your profile to make ordering and delivery easier.'
    : 'Keep your contact and class/room details up to date.';

  return (
    <div
      className="person-profile-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !required) onClose?.();
      }}
    >
      <div className="person-profile-modal" role="dialog" aria-modal="true" aria-labelledby="person-profile-title">
        {!required && (
          <button type="button" className="person-profile-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        )}
        <h2 id="person-profile-title">{title}</h2>
        <p className="person-profile-subtitle">{subtitle}</p>

        <div className="person-profile-progress" aria-live="polite">
          <div className="person-profile-progress-top">
            <span>Profile {percent}% complete</span>
            <span>{percent}%</span>
          </div>
          <div className="person-profile-progress-track">
            <div className="person-profile-progress-fill" style={{ width: `${percent}%` }} />
          </div>
        </div>

        <form className="person-profile-form" onSubmit={handleSubmit} noValidate>
          <div className="form-group">
            <label htmlFor="profile_full_name">Full Name</label>
            <input
              id="profile_full_name"
              type="text"
              autoComplete="name"
              placeholder="e.g. Rahul Kumar"
              value={form.full_name}
              onChange={(e) => update('full_name', e.target.value)}
            />
            {(errors.full_name || (form.full_name.trim() && fieldErrors.full_name)) && (
              <span className="person-field-error">{errors.full_name || fieldErrors.full_name}</span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="profile_phone_number">Phone Number</label>
            <input
              id="profile_phone_number"
              type="tel"
              inputMode="numeric"
              autoComplete="tel"
              placeholder="e.g. 9876543210"
              value={form.phone_number}
              onChange={(e) => update('phone_number', e.target.value)}
            />
            {(errors.phone_number || (form.phone_number.trim() && fieldErrors.phone_number)) && (
              <span className="person-field-error">{errors.phone_number || fieldErrors.phone_number}</span>
            )}
          </div>
          <div className="form-group">
            <label htmlFor="profile_class_room">Class / Room Number</label>
            <input
              id="profile_class_room"
              type="text"
              placeholder="e.g. B-204"
              value={form.class_room_number}
              onChange={(e) => update('class_room_number', e.target.value)}
            />
            {(errors.class_room_number || (form.class_room_number.trim() && fieldErrors.class_room_number)) && (
              <span className="person-field-error">{errors.class_room_number || fieldErrors.class_room_number}</span>
            )}
          </div>

          {serverError && <p className="person-field-error person-form-error">{serverError}</p>}

          <button
            type="submit"
            className="person-save-btn"
            disabled={!isValid || saving}
          >
            {saving ? 'Saving…' : justSaved ? 'Saved ✓' : 'Save Profile →'}
          </button>
        </form>
      </div>
    </div>
  );
}
