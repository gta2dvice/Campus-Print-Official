const POLICY_MESSAGE = 'Password must be at least 6 characters.';

const SPECIAL_CHARS = '!@#$%^&*';
const COMMON_PASSWORDS = new Set([
    '123456', '123123', '111111', '000000', '654321', '121212', '112233',
    'abcdef', 'abcabc', 'abc123', 'aaa111', 'qwerty', 'asdfgh', 'zxcvbn',
    'qwe123', 'pass12', 'admin1', 'letmein', 'welcome', 'password', 'passwd',
    'iloveyou', 'monkey', 'dragon', 'master', 'shadow', '123abc'
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

function evaluatePassword(password, context = {}) {
    const value = String(password || '');
    const checks = [
        {
            id: 'length',
            label: 'At least 6 characters',
            warning: 'Password must be at least 6 characters.',
            passed: value.length >= 6,
            mandatory: true
        },
        {
            id: 'upper',
            label: 'At least 1 uppercase letter (A–Z)',
            warning: 'We recommend adding at least one uppercase letter (A–Z).',
            passed: /[A-Z]/.test(value),
            mandatory: false
        },
        {
            id: 'lower',
            label: 'At least 1 lowercase letter (a–z)',
            warning: 'We recommend adding at least one lowercase letter (a–z).',
            passed: /[a-z]/.test(value),
            mandatory: false
        },
        {
            id: 'number',
            label: 'At least 1 number (0–9)',
            warning: 'We recommend adding at least one number (0–9).',
            passed: /[0-9]/.test(value),
            mandatory: false
        },
        {
            id: 'special',
            label: 'At least 1 special character (!@#$%^&*)',
            warning: 'We recommend adding at least one special character (!@#$%^&*).',
            passed: new RegExp(`[${SPECIAL_CHARS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}]`).test(value),
            mandatory: false
        },
        {
            id: 'personal',
            label: 'Does not contain your name, username, or email',
            warning: 'Password should not contain your name, username, or email.',
            passed: value.length === 0 ? false : !containsPersonalInfo(value, context),
            mandatory: false
        },
        {
            id: 'common',
            label: 'Not a common or obvious password',
            warning: 'This password is too common. Choose something less obvious.',
            passed: value.length === 0 ? false : !COMMON_PASSWORDS.has(value.toLowerCase()),
            mandatory: false
        },
        {
            id: 'pattern',
            label: 'No simple sequential or repetitive patterns',
            warning: 'Avoid sequential or repeated characters (for example 1234 or aaa).',
            passed: value.length === 0 ? false : !hasSequentialOrRepeat(value),
            mandatory: false
        }
    ];

    const mandatoryFailed = checks.filter((check) => check.mandatory && !check.passed);
    const allFailed = checks.filter((check) => !check.passed);
    const passedCount = checks.filter((check) => check.passed).length;
    let strength = 'weak';
    if (passedCount >= 8) strength = 'strong';
    else if (passedCount >= 5) strength = 'medium';

    return {
        ok: mandatoryFailed.length === 0,
        checks,
        failed: allFailed,
        mandatoryFailed,
        strength,
        message: POLICY_MESSAGE
    };
}

function validatePassword(password, context = {}) {
    const result = evaluatePassword(password, context);
    if (result.ok) return { ok: true, message: POLICY_MESSAGE };
    const mandatoryDetails = result.mandatoryFailed.map((check) => check.warning);
    return {
        ok: false,
        message: POLICY_MESSAGE,
        details: mandatoryDetails
    };
}

function identityContext(email, extraName = '') {
    const normalized = String(email || '').toLowerCase().trim();
    return {
        email: normalized,
        username: normalized.split('@')[0] || '',
        name: extraName || '',
        fullName: extraName || ''
    };
}

module.exports = {
    POLICY_MESSAGE,
    evaluatePassword,
    validatePassword,
    identityContext
};
