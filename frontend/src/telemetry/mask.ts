// Privacy helpers. Nothing in the telemetry client reads an input's value, so there is
// nothing to leak from a field; these helpers cover the remaining free-text surfaces
// (URLs, error messages, stack traces, selectors).

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const LONG_DIGITS = /\b\d{6,}\b/g
const TOKENISH = /\b[A-Za-z0-9_-]{32,}\b/g

export function sanitizeRoute(url: string): string {
  try {
    const u = new URL(url, 'http://local.invalid')
    return u.pathname.slice(0, 200) || '/'
  } catch {
    return '/'
  }
}

export function scrubText(input: unknown, max: number): string {
  if (typeof input !== 'string') return ''
  return input
    .replace(EMAIL, '<email>')
    .replace(TOKENISH, '<token>')
    .replace(LONG_DIGITS, '<num>')
    .slice(0, max)
}

/** Stack frames keep file and position but lose query strings, which can carry tokens. */
export function scrubStack(stack: unknown): string {
  if (typeof stack !== 'string') return ''
  return scrubText(stack.replace(/\?[^\s):]*/g, ''), 1000)
}

export interface ElementLike {
  tagName: string
  id?: string
  className?: unknown
  getAttribute?: (name: string) => string | null
  closest?: (selector: string) => ElementLike | null
}

/** Opt-out marker: any element inside `.tel-exclude` is never described. */
export const EXCLUDE_CLASS = 'tel-exclude'

export function isExcluded(el: ElementLike | null): boolean {
  if (!el) return true
  try {
    if (el.closest?.(`.${EXCLUDE_CLASS}`)) return true
  } catch { /* ignore */ }
  const type = (el.getAttribute?.('type') || '').toLowerCase()
  const autocomplete = (el.getAttribute?.('autocomplete') || '').toLowerCase()
  return type === 'password' || type === 'hidden' || autocomplete.startsWith('cc-')
}

/** tag#id.class selector. Never includes text content or attribute values. */
export function describeElement(el: ElementLike | null): string {
  if (!el || isExcluded(el)) return '[excluded]'
  const tag = String(el.tagName || 'unknown').toLowerCase()
  const id = el.id ? `#${String(el.id).slice(0, 40)}` : ''
  const cls = typeof el.className === 'string'
    ? el.className.split(/\s+/).filter(c => c && /^[\w-]{1,30}$/.test(c)).slice(0, 2).map(c => `.${c}`).join('')
    : ''
  return `${tag}${id}${cls}`.slice(0, 120)
}
