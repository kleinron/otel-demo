import { CART_UUID_PATTERN } from './cart.js';

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
/** Key that names a cart or session id: cartId, cart_id, cart.id, x-session-id, SessionId. */
const SESSION_KEY_PATTERN = /(session|cart)[._-]?id$/i;
/** A cart or session id value inside raw text: cookies, headers, query strings, JSON bodies. */
const RAW_SESSION_PATTERN = /((?:session|cart)[._-]?id\s*[=:]\s*)([^;,&\s"'\\]+)/gi;
/** The same inside JSON text, including JSON escaped inside a string. */
const JSON_SESSION_PATTERN = /((?:session|cart)[._-]?id\\?"\s*:\s*\\?")([^"\\]+)/gi;
const REDACTED_EMAIL = '[REDACTED_EMAIL]';
const REDACTED_PHONE = '[REDACTED_PHONE]';
const MAX_DEPTH = 8;

export function isSecretKey(key: string): boolean {
  if (SESSION_KEY_PATTERN.test(key)) {
    return true;
  }
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
    .replace(AWS_ACCESS_KEY_PATTERN, REDACTED)
    .replace(RAW_SESSION_PATTERN, `$1${REDACTED}`)
    .replace(JSON_SESSION_PATTERN, `$1${REDACTED}`);
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
    if (isSecretKey(key)) {
      redacted[key] = REDACTED;
    } else if (/^(session|cart)$/i.test(key) && isRecord(child) && 'id' in child) {
      redacted[key] = { ...(redactLogValue(child, depth + 1) as object), id: REDACTED };
    } else {
      redacted[key] = redactLogValue(child, depth + 1);
    }
  }
  return redacted;
}

/**
 * Redact one log entry and attach our own cart id.
 *
 * Any cart or session id in the entry (a `cart.id` / `cartId` / `sessionId`
 * key, a nested `cart.id` or `session.id`, a `cartid=` or `sessionid=` in a
 * cookie, header, or body) is raw request data and is redacted, even when it
 * looks like a UUID. The only value kept is `ownCartId`, the one our code read
 * from W3C baggage, and only when it is a UUID v4. It is written nested as
 * `{ cart: { id } }` so a Logs Explorer filter on `jsonPayload.cart.id` matches.
 */
export function redactLogEntry(
  entry: Record<string, unknown>,
  ownCartId?: string,
): Record<string, unknown> {
  const { cart: rawCart, ...rest } = entry;
  const out = redactLogValue(rest) as Record<string, unknown>;
  if (rawCart !== undefined && !isRecord(rawCart)) {
    out.cart = REDACTED;
  } else if (isRecord(rawCart)) {
    out.cart = { ...(redactLogValue(rawCart) as object), id: REDACTED };
  }
  if (ownCartId !== undefined) {
    const base = isRecord(out.cart) ? out.cart : {};
    out.cart = { ...base, id: CART_UUID_PATTERN.test(ownCartId) ? ownCartId : REDACTED };
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
