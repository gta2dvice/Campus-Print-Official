import { evaluatePassword, POLICY_MESSAGE } from '../lib/passwordPolicy';
import './password-policy.css';

export default function PasswordPolicyHints({ password, email, name, username, className = '' }) {
  const result = evaluatePassword(password, { email, name, username });
  const failed = result.failed;

  if (failed.length === 0) return null;

  return (
    <div className={`password-policy ${className}`.trim()}>
      <ul className="password-policy-list">
        {failed.map((check) => (
          <li key={check.id} className="is-incomplete">
            <span className="password-policy-mark" aria-hidden="true">!</span>
            <span>{check.warning}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
