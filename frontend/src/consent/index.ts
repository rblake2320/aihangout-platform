import {
  analyticsAllowed as allowed, hasOptOutSignal, needsBanner as needs, readConsent as read, writeConsent as write,
  type ConsentState, type KV,
} from './consent'

export { POLICY_VERSION } from './consent'
export type { ConsentState } from './consent'

const EVENT = 'aih-consent-change'

/** localStorage, or a no-op store when storage is blocked (private mode, hardened browsers). */
const store: KV = {
  getItem: k => { try { return localStorage.getItem(k) } catch { return null } },
  setItem: (k, v) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } },
}

function signals() {
  const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
  return { doNotTrack: nav.doNotTrack ?? null, globalPrivacyControl: nav.globalPrivacyControl === true }
}

export const optOutSignalPresent = (): boolean => hasOptOutSignal(signals())
export const analyticsAllowed = (): boolean => allowed(store, signals())
export const needsBanner = (): boolean => needs(store, signals())
export const currentConsent = (): ConsentState | null => read(store)

/** Store a decision, tell listeners, and keep a server-side record for proof of consent. */
export function setAnalyticsConsent(analytics: boolean, source: 'banner' | 'settings' = 'banner', token?: string | null): void {
  write(store, analytics)
  window.dispatchEvent(new Event(EVENT))
  void fetch('/api/consent', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ analytics, source }),
  }).catch(() => { /* the local decision is authoritative; the log is best-effort */ })
}

export function onConsentChange(cb: () => void): () => void {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener('storage', cb) }
}
