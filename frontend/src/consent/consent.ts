// AIH-R4 consent decision store. Pure (storage and navigator are injected) so the root
// vitest suite can test it without a DOM.

/** Bump with every material change to /privacy; a new version asks again. */
export const POLICY_VERSION = '2026-10-31'
export const CONSENT_KEY = 'aih_consent'

export interface KV {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface ConsentState {
  analytics: boolean
  policyVersion: string
  decidedAt: string
}

export interface PrivacySignals {
  doNotTrack?: string | null
  globalPrivacyControl?: boolean
}

/** Do Not Track or Global Privacy Control is an automatic "no" and is never overridden by a stored "yes". */
export function hasOptOutSignal(nav: PrivacySignals): boolean {
  return nav.globalPrivacyControl === true || nav.doNotTrack === '1' || nav.doNotTrack === 'yes'
}

/** Stored decision for the current policy version, or null (none, unreadable, or from an older policy). */
export function readConsent(store: KV): ConsentState | null {
  try {
    const raw = store.getItem(CONSENT_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Partial<ConsentState>
    if (typeof s.analytics !== 'boolean' || s.policyVersion !== POLICY_VERSION || typeof s.decidedAt !== 'string') return null
    return { analytics: s.analytics, policyVersion: s.policyVersion, decidedAt: s.decidedAt }
  } catch {
    return null
  }
}

export function writeConsent(store: KV, analytics: boolean, now: Date = new Date()): ConsentState {
  const state: ConsentState = { analytics, policyVersion: POLICY_VERSION, decidedAt: now.toISOString() }
  try { store.setItem(CONSENT_KEY, JSON.stringify(state)) } catch { /* storage blocked: decision lasts for this page only */ }
  return state
}

/** Behavioural telemetry may run only with an explicit current "yes" and no opt-out signal. */
export function analyticsAllowed(store: KV, nav: PrivacySignals): boolean {
  if (hasOptOutSignal(nav)) return false
  return readConsent(store)?.analytics === true
}

/** The banner is needed when there is no current decision and the browser has not already said no. */
export function needsBanner(store: KV, nav: PrivacySignals): boolean {
  return !hasOptOutSignal(nav) && readConsent(store) === null
}
