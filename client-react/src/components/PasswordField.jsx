import { useState } from 'react';
import './password-policy.css';

export default function PasswordField({
  id,
  name,
  label,
  value,
  onChange,
  autoComplete,
  required,
  maxLength,
  placeholder,
  inputClassName = '',
  labelClassName = '',
}) {
  const [visible, setVisible] = useState(false);

  return (
    <div className={labelClassName || 'form-group'}>
      {label ? <label htmlFor={id}>{label}</label> : null}
      <div className="password-field">
        <input
          type={visible ? 'text' : 'password'}
          id={id}
          name={name}
          autoComplete={autoComplete}
          required={required}
          maxLength={maxLength}
          placeholder={placeholder}
          value={value}
          onChange={onChange}
          className={inputClassName}
        />
        <button
          type="button"
          className="password-toggle"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? 'Hide password' : 'Show password'}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}
