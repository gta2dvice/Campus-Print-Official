export const POLICY_MESSAGE = 'Password must be exactly 6 characters and include at least one uppercase letter, lowercase letter, number, and special character.';

const SPECIAL_CHARS = '!@#$%^&*';
const COMMON_PASSWORDS = new Set([
  '123456', '123123', '111111', '000000', '654321', '121212', '112233',
  'abcdef', 'abcabc', 'abc123', 'aaa111', 'qwerty', 'asdfgh', 'zxcvbn',
  'qwe123', 'pass12', 'admin1', 'letmein', 'welcome', 'password', 'passwd',
  'iloveyou', 'monkey', 'dragon', 'master', 'shadow', '123abc',
]);
const KEYBOARD_ROWS = ['abcdefghijklmnopqrstuvwxyz', '0123456789', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

function personalTokens({ email = '', username = '', name = '', fullName = '' } = {}) {
  const raw = [email, username, name, fullName]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .split(/[@._\s-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 3);
  return [...new Set(raw)];
}

function hasSequentialOrRepeat(password) {
  if (/(.)\1{2,}/.test(password)) return true;
  const lower = password.toLowerCase();
  for (const row of KEYBOARD_ROWS) {
    const reversed = row.split('').reverse().join('');
    for (let i = 0; i <= lower.length - 4; i++) {
      const slice = lower.slice(i, i + 4);
      if (row.includes(slice) || reversed.includes(slice)) return true;
    }
  }
  return false;
}

function containsPersonalInfo(password, context) {
  const lower = password.toLowerCase();
  return personalTokens(context).some((token) => lower.includes(token));
}

export function evaluatePassword(password, context = {}) {
  const value = String(password || '');
  const checks = [
    {
      id: 'length',
      label: 'Exactly 6 characters',
      warning: 'Password must be exactly 6 characters.',
      passed: value.length === 6,
    },
    {
      id: 'upper',
      label: 'At least 1 uppercase letter (A–Z)',
      warning: 'Add at least one uppercase letter (A–Z).',
      passed: /[A-Z]/.test(value),
    },
    {
      id: 'lower',
      label: 'At least 1 lowercase letter (a–z)',
      warning: 'Add at least one lowercase letter (a–z).',
      passed: /[a-z]/.test(value),
    },
    {
      id: 'number',
      label: 'At least 1 number (0–9)',
      warning: 'Add at least one number (0–9).',
      passed: /[0-9]/.test(value),
    },
    {
      id: 'special',
      label: 'At least 1 special character (!@#$%^&*)',
      warning: 'Add at least one special character (!@#$%^&*).',
      passed: new RegExp(`[${SPECIAL_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`).test(value),
    },
    {
      id: 'personal',
      label: 'Does not contain your name, username, or email',
      warning: 'Password cannot contain your name, username, or email.',
      passed: value.length === 0 ? false : !containsPersonalInfo(value, context),
    },
    {
      id: 'common',
      label: 'Not a common or obvious password',
      warning: 'This password is too common. Choose something less obvious.',
      passed: value.length === 0 ? false : !COMMON_PASSWORDS.has(value.toLowerCase()),
    },
    {
      id: 'pattern',
      label: 'No simple sequential or repetitive patterns',
      warning: 'Avoid sequential or repeated characters (for example 1234 or aaa).',
      passed: value.length === 0 ? false : !hasSequentialOrRepeat(value),
    },
  ];

  const failed = checks.filter((check) => !check.passed);
  const passedCount = checks.filter((check) => check.passed).length;
  let strength = 'weak';
  if (passedCount >= 8) strength = 'strong';
  else if (passedCount >= 5) strength = 'medium';

  return {
    ok: failed.length === 0,
    checks,
    failed,
    strength,
    message: POLICY_MESSAGE,
  };
}
