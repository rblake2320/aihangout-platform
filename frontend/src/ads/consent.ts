// Ad impression/click events follow the site's analytics consent (AIH-R4): an explicit,
// current "yes" stored under aih_consent, and no Do Not Track / Global Privacy Control.
// This mirrors the R4 decision store so ads ship independently; once R4 is merged, swap
// adEventsAllowed() for analyticsAllowed() from '../consent' and delete this file.
const CONSENT_KEY = 'aih_consent'
const POLICY_VERSION = '2026-10-31'

export function adEventsAllowed(): boolean {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean }
    if (nav.globalPrivacyControl === true || nav.doNotTrack === '1' || nav.doNotTrack === 'yes') return false
    const raw = localStorage.getItem(CONSENT_KEY)
    if (!raw) return false
    const s = JSON.parse(raw)
    return s?.analytics === true && s?.policyVersion === POLICY_VERSION
  } catch {
    return false
  }
}
