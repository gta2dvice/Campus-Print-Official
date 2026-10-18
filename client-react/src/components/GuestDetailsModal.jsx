import { useState } from 'react';

export default function GuestDetailsModal({ isOpen, onClose, onSubmit }) {
  const [formData, setFormData] = useState({
    fullName: '',
    email: '',
    phone: '',
    classroom: '',
    batch: '',
    classSection: ''
  });
  const [error, setError] = useState('');

  if (!isOpen) return null;

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    if (error) setError('');
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setError('');

    const name = formData.fullName.trim();
    const email = formData.email.trim().toLowerCase();
    const phone = formData.phone.trim();
    const classroom = formData.classroom.trim();
    const batch = formData.batch.trim();
    const classSection = formData.classSection.trim();

    if (!name || name.length < 2) {
      setError('Please enter your full name.');
      return;
    }

    const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
    if (!email || !emailRegex.test(email)) {
      setError('Enter a valid email address for order notifications and recovery.');
      return;
    }

    const phoneRegex = /^[6-9][0-9]{9}$/;
    if (!phoneRegex.test(phone)) {
      setError('Enter a valid 10-digit mobile number.');
      return;
    }

    if (!classroom || classroom.length < 2) {
      setError('Please enter a valid classroom/room number.');
      return;
    }

    if (batch) {
      const batchRegex = /^[0-9]{4}-[0-9]{4}$/;
      if (!batchRegex.test(batch)) {
        setError('Enter batch in YYYY-YYYY format (e.g. 2024-2028).');
        return;
      }
      const [start, end] = batch.split('-').map(Number);
      if (end <= start) {
        setError('Ending year must be greater than starting year.');
        return;
      }
    }

    if (classSection) {
      if (/^\d+$/.test(classSection)) {
        setError('Enter a valid class/section (e.g. CSE-A).');
        return;
      }
    }

    onSubmit({ ...formData, email });
  };

  return (
    <div className="modal-overlay active">
      <div className="modal-content">
        <button className="close-btn" onClick={onClose}>✕</button>

        <div className="modal-header" style={{ flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
          <h2 style={{ fontSize: '1.5rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
            Start Your Project
          </h2>
          <p style={{ fontSize: '0.95rem', color: 'var(--text-secondary)', marginBottom: '1.5rem' }}>
            Let's get your print ready.
          </p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="fullName">Full Name *</label>
            <input
              type="text"
              id="fullName"
              name="fullName"
              placeholder="Enter your full name"
              value={formData.fullName}
              onChange={handleChange}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="email">Email Address *</label>
            <input
              type="email"
              id="email"
              name="email"
              placeholder="e.g. name@university.edu"
              value={formData.email}
              onChange={handleChange}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="phone">Phone Number *</label>
            <input
              type="tel"
              id="phone"
              name="phone"
              placeholder="Enter your phone number"
              value={formData.phone}
              onChange={handleChange}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="classroom">Classroom / Room Number *</label>
            <input
              type="text"
              id="classroom"
              name="classroom"
              placeholder="e.g. 301 or AB-301"
              value={formData.classroom}
              onChange={handleChange}
              required
            />
          </div>

          <div className="form-group">
            <label htmlFor="batch">Batch</label>
            <input
              type="text"
              id="batch"
              name="batch"
              placeholder="e.g. 2024-2028"
              value={formData.batch}
              onChange={handleChange}
            />
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px', display: 'block' }}>Optional</span>
          </div>

          <div className="form-group">
            <label htmlFor="classSection">Class / Section</label>
            <input
              type="text"
              id="classSection"
              name="classSection"
              placeholder="e.g. CSE-A"
              value={formData.classSection}
              onChange={handleChange}
            />
            <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '2px', display: 'block' }}>Optional</span>
          </div>

          {error && <div className="auth-error">{error}</div>}

          <button type="submit" className="btn btn-primary submit-btn">
            Continue
            <span className="arrow-icon">&rarr;</span>
          </button>
        </form>
      </div>
    </div>
  );
}
