const EXACT_SECRET_KEYS = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'secretaccesskey',
  'authorization',
  'proxyauthorization',
  'cookie',
  'setcookie',
  'credentials',
  'privatekey',
  'clientsecret',
  'sessiontoken',
  'sessionid',
]);

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE_PATTERN =
  /\+\d{10,15}\b|(?:\+\d{1,3}[\s.-])?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const AWS_ACCESS_KEY_PATTERN = /\bAKIA[0-9A-Z]{16}\b/g;

const REDACTED = '[REDACTED]';
const REDACTED_EMAIL = '[REDACTED_EMAIL]';
const REDACTED_PHONE = '[REDACTED_PHONE]';
const MAX_DEPTH = 8;

export function isSecretKey(key: string): boolean {
  const compact = key.replace(/[_-]/g, '').toLowerCase();
  if (EXACT_SECRET_KEYS.has(compact)) {
    return true;
  }
  return (
    compact.includes('password') ||
    compact.includes('secretaccesskey') ||
    compact.includes('apikey') ||
    compact.includes('privatekey') ||
    compact.includes('clientsecret') ||
    compact.includes('authorization') ||
    compact.includes('accesstoken') ||
    compact.includes('refreshtoken') ||
    compact.includes('sessiontoken') ||
    compact.includes('idtoken')
  );
}

export function redactSensitiveText(input: string): string {
  return input
    .replace(EMAIL_PATTERN, REDACTED_EMAIL)
    .replace(PHONE_PATTERN, REDACTED_PHONE)
    .replace(BEARER_PATTERN, 'Bearer [REDACTED]')
    .replace(AWS_ACCESS_KEY_PATTERN, REDACTED);
}

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return REDACTED;
  }
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, depth + 1));
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    redacted[key] = isSecretKey(key) ? REDACTED : redactLogValue(child, depth + 1);
  }
  return redacted;
}
