// AIH-R6: pure validation for editable profiles (no I/O, so it is unit-testable).

export const BIO_MAX = 500;
export const LINKS_MAX = 5;
export const LABEL_MAX = 40;
export const URL_MAX = 200;
export const AVATAR_MAX_BYTES = 512 * 1024;

/** Image types we accept. SVG is deliberately absent: it can carry script. */
export const AVATAR_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/**
 * Identify an image by its magic bytes. The declared Content-Type is never trusted:
 * a file must both claim and actually be PNG, JPEG or WebP.
 */
export function sniffImageType(bytes) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/**
 * Validate an uploaded avatar. Returns { ok: true, type, ext } or { ok: false, status, error }.
 * `declaredType` is the request Content-Type; `bytes` is the full body.
 */
export function validateAvatar(declaredType, bytes) {
  const declared = String(declaredType || '').split(';')[0].trim().toLowerCase();
  if (!AVATAR_TYPES[declared]) return { ok: false, status: 415, error: 'Avatar must be image/png, image/jpeg or image/webp' };
  if (!bytes || bytes.length === 0) return { ok: false, status: 400, error: 'Empty upload' };
  if (bytes.length > AVATAR_MAX_BYTES) return { ok: false, status: 413, error: `Avatar must be at most ${AVATAR_MAX_BYTES / 1024} KB` };
  const actual = sniffImageType(bytes);
  if (actual !== declared) return { ok: false, status: 415, error: 'File content does not match the declared image type' };
  return { ok: true, type: declared, ext: AVATAR_TYPES[declared] };
}

/** Remove control characters other than newline/tab, trim, and cap length (in characters). */
function cleanText(value, max) {
  return Array.from(String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()).slice(0, max).join('');
}

/** Bio: plain text. `sanitize` is the worker's content sanitizer (HTML, LLM tokens, bidi). */
export function validateBio(bio, sanitize) {
  if (bio === null || bio === undefined || bio === '') return { ok: true, value: '' };
  if (typeof bio !== 'string') return { ok: false, error: 'bio must be a string' };
  if (Array.from(bio).length > BIO_MAX) return { ok: false, error: `bio must be at most ${BIO_MAX} characters` };
  return { ok: true, value: cleanText(sanitize(bio), BIO_MAX) };
}

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.lan|.*\.corp)$/i;

function isPrivateIPv4(host) {
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Normalise one profile link to https/http with no credentials and a public hostname, or null. */
export function normalizeLinkUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.startsWith('[') || PRIVATE_HOST.test(host) || isPrivateIPv4(host)) return null;
  const out = u.toString();
  return out.length <= URL_MAX ? out : null;
}

/** Links: up to 5 { label, url }. Returns { ok, value } or { ok: false, error }. */
export function validateLinks(links, sanitize) {
  if (links === null || links === undefined) return { ok: true, value: [] };
  if (!Array.isArray(links)) return { ok: false, error: 'links must be an array' };
  if (links.length > LINKS_MAX) return { ok: false, error: `At most ${LINKS_MAX} links` };
  const value = [];
  for (const [i, l] of links.entries()) {
    if (!l || typeof l !== 'object') return { ok: false, error: `link ${i + 1} must be an object` };
    const url = normalizeLinkUrl(l.url);
    if (!url) return { ok: false, error: `link ${i + 1}: url must be a public http(s) address` };
    const label = cleanText(sanitize(String(l.label ?? '')), LABEL_MAX);
    if (!label) return { ok: false, error: `link ${i + 1}: label is required` };
    value.push({ label, url });
  }
  return { ok: true, value };
}

/** Avatar object names are server-generated; this guards the public read route. */
export const AVATAR_FILE_RE = /^[a-f0-9]{32}\.(png|jpg|webp)$/;
