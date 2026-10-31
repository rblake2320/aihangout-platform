import type { TelemetryBatch } from './types'

export interface TransportDeps {
  fetchFn: typeof fetch
  sendBeacon?: (url: string, data: BodyInit) => boolean
  getToken: () => string | null
}

/**
 * Normal flushes use fetch with keepalive so the bearer token can ride along. During
 * unload the page may die before fetch completes, so sendBeacon is tried first; it cannot
 * carry headers, so the server attributes those rows by session id. If the beacon is
 * unavailable or refuses the payload, fetch with keepalive is the fallback.
 */
export async function sendBatch(endpoint: string, batch: TelemetryBatch, deps: TransportDeps, unloading: boolean): Promise<boolean> {
  const body = JSON.stringify(batch)
  if (unloading && deps.sendBeacon) {
    try {
      if (deps.sendBeacon(endpoint, new Blob([body], { type: 'text/plain;charset=UTF-8' }))) return true
    } catch { /* fall through to fetch */ }
  }
  try {
    const token = deps.getToken()
    const res = await deps.fetchFn(endpoint, {
      method: 'POST',
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body,
    })
    return res.ok
  } catch {
    return false
  }
}
