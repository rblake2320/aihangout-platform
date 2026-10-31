// AIH-R8: pure helpers for the white-paper library (no I/O, unit-testable).

export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const TITLE_MAX = 200;
export const ABSTRACT_MAX = 2000;
export const AUTHORS_MAX = 10;
export const AUTHOR_MAX = 100;
export const CHANGELOG_MAX = 500;
export const INLINE_CONTENT_MAX = 200 * 1024;

export const LICENSES = ['CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0', 'MIT', 'Apache-2.0', 'All-Rights-Reserved'];

const FILE_TYPES = {
  pdf: { mimes: ['application/pdf'], contentType: 'application/pdf' },
  md: { mimes: ['text/markdown', 'text/plain', 'text/x-markdown'], contentType: 'text/markdown; charset=utf-8' },
};

/**
 * Validate an uploaded document by extension, declared type and CONTENT.
 * PDF: must start with "%PDF-" and contain an "%%EOF" marker near the end.
 * Markdown: must be valid UTF-8 with no NUL or other control bytes.
 * Returns { ok: true, ext, contentType } or { ok: false, status, error }.
 */
export function validateDocumentFile(filename, declaredType, bytes) {
  const ext = String(filename || '').toLowerCase().match(/\.(pdf|md)$/)?.[1];
  if (!ext) return { ok: false, status: 415, error: 'File name must end in .pdf or .md' };
  const declared = String(declaredType || '').split(';')[0].trim().toLowerCase();
  if (!FILE_TYPES[ext].mimes.includes(declared)) return { ok: false, status: 415, error: `Content-Type ${declared || '(none)'} does not match .${ext}` };
  if (!bytes || bytes.length === 0) return { ok: false, status: 400, error: 'Empty file' };
  if (bytes.length > FILE_MAX_BYTES) return { ok: false, status: 413, error: `File must be at most ${FILE_MAX_BYTES / 1024 / 1024} MB` };
  if (ext === 'pdf') {
    const head = String.fromCharCode(...bytes.subarray(0, 5));
    const tail = String.fromCharCode(...bytes.subarray(Math.max(0, bytes.length - 1024)));
    if (head !== '%PDF-' || !tail.includes('%%EOF')) return { ok: false, status: 415, error: 'File is not a complete PDF' };
  } else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return { ok: false, status: 415, error: 'Markdown must be valid UTF-8' }; }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) return { ok: false, status: 415, error: 'Markdown contains control characters' };
  }
  return { ok: true, ext, contentType: FILE_TYPES[ext].contentType };
}

const clean = (v, max) => Array.from(String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()).slice(0, max).join('');

/** Authors arrive as a JSON array or a comma/semicolon separated string. */
export function parseAuthors(input) {
  let list = input;
  if (typeof input === 'string') {
    const t = input.trim();
    if (t.startsWith('[')) { try { list = JSON.parse(t); } catch { return { ok: false, error: 'authors is not valid JSON' }; } }
    else list = t.split(/[;,]/);
  }
  if (!Array.isArray(list)) return { ok: false, error: 'authors must be a list' };
  const authors = list.map((a) => clean(a, AUTHOR_MAX)).filter(Boolean);
  if (authors.length === 0) return { ok: false, error: 'At least one author is required' };
  if (authors.length > AUTHORS_MAX) return { ok: false, error: `At most ${AUTHORS_MAX} authors` };
  return { ok: true, value: authors };
}

/**
 * Validate document metadata. `sanitize` is the worker's content sanitizer.
 * With { partial: true } absent fields are skipped (used for new versions).
 */
export function validateMeta(input, sanitize, { partial = false } = {}) {
  const out = {};
  if (!partial || input.title !== undefined) {
    const title = clean(sanitize(input.title), TITLE_MAX);
    if (!title) return { ok: false, error: 'title is required' };
    out.title = title;
  }
  if (!partial || input.abstract !== undefined) {
    const abstract = clean(sanitize(input.abstract), ABSTRACT_MAX);
    if (!abstract) return { ok: false, error: 'abstract is required' };
    out.abstract = abstract;
  }
  if (!partial || input.authors !== undefined) {
    const a = parseAuthors(input.authors);
    if (!a.ok) return a;
    out.authors = a.value.map((x) => clean(sanitize(x), AUTHOR_MAX));
  }
  if (!partial || input.license !== undefined) {
    if (!LICENSES.includes(input.license)) return { ok: false, error: `license must be one of ${LICENSES.join(', ')}` };
    out.license = input.license;
  }
  if (input.changelog !== undefined) out.changelog = clean(sanitize(input.changelog), CHANGELOG_MAX);
  return { ok: true, value: out };
}

export const citationId = (id, year) => `AIH-LIB-${year}-${String(id).padStart(4, '0')}`;
export const versionCitation = (citation, version) => `${citation}v${version}`;

/** "12" | "AIH-LIB-2026-0012" | "AIH-LIB-2026-0012v3" -> { id } | { citation, version? } | null */
export function parseRef(ref) {
  const s = String(ref || '');
  if (/^\d{1,9}$/.test(s)) return { id: Number(s) };
  const m = s.match(/^(AIH-LIB-\d{4}-\d{4,})(?:v(\d{1,4}))?$/);
  if (m) return { citation: m[1], ...(m[2] ? { version: Number(m[2]) } : {}) };
  return null;
}

/** Escape LIKE wildcards so user text is matched literally (use with ESCAPE '\'). */
export const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

/** Content-Disposition filename: ASCII slug only, never user text. */
export const downloadName = (citation, version, ext) => `${citation}v${version}.${ext}`;
