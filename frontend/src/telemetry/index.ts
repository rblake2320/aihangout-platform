import { ActivityClock } from './activity'
import { DeadClickDetector, isDeadClickCandidate } from './dead'
import { describeElement, isExcluded, sanitizeRoute, scrubStack, scrubText, type ElementLike } from './mask'
import { EventQueue } from './queue'
import { RageDetector } from './rage'
import { sendBatch } from './transport'
import { DEFAULT_CONFIG, type EventType, type TelemetryConfig, type TelemetryEvent } from './types'

export { EVENT_TYPES, DEFAULT_CONFIG } from './types'
export type { TelemetryConfig, TelemetryEvent, EventType } from './types'

export interface TelemetryOptions {
  config?: Partial<TelemetryConfig>
  getToken?: () => string | null
  /** Kill switch. Read once at start; a disabled client installs nothing. */
  enabled?: boolean
}

export interface Telemetry {
  start(): void
  stop(): void
  flush(unloading?: boolean): Promise<void>
}

const SESSION_KEY = 'aih_tel_session'

function randomId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

function loadSession(now: number, idleExpiryMs: number, sampleRate: number): { id: string; sampled: boolean } {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (raw) {
      const s = JSON.parse(raw) as { id: string; sampled: boolean; last: number }
      if (s.id && now - s.last < idleExpiryMs) return { id: s.id, sampled: s.sampled }
    }
  } catch { /* storage unavailable: fall through to a fresh in-memory session */ }
  return { id: randomId(), sampled: Math.random() < sampleRate }
}

function saveSession(id: string, sampled: boolean, now: number): void {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ id, sampled, last: now })) } catch { /* ignore */ }
}

export function createTelemetry(options: TelemetryOptions = {}): Telemetry {
  const cfg: TelemetryConfig = {
    ...DEFAULT_CONFIG,
    ...options.config,
    rage: { ...DEFAULT_CONFIG.rage, ...options.config?.rage },
    batch: { ...DEFAULT_CONFIG.batch, ...options.config?.batch },
    backoff: { ...DEFAULT_CONFIG.backoff, ...options.config?.backoff },
  }
  const getToken = options.getToken ?? (() => null)
  const SESSION_EXPIRY_MS = 30 * 60 * 1000

  let running = false
  const teardown: Array<() => void> = []

  const noop: Telemetry = { start() {}, stop() {}, async flush() {} }
  if (typeof window === 'undefined' || options.enabled === false) return noop
  if (navigator.doNotTrack === '1') return noop

  const session = loadSession(Date.now(), SESSION_EXPIRY_MS, cfg.sampleRate)
  if (!session.sampled) return noop

  const queue = new EventQueue(cfg)
  const rage = new RageDetector(cfg.rage)
  let route = sanitizeRoute(location.href)
  let routeEnteredAt = Date.now()
  let maxScrollPct = 0
  let errorsThisPage = 0
  const seenErrors = new Set<string>()
  const clock = new ActivityClock(cfg.idleMs, Date.now())
  const touchedForms = new Map<Element, { fields: Set<string>; last: string; firstAt: number; submitted: boolean }>()
  let pageOpen = false // pagehide and visibilitychange both fire on unload; only the first may close the page
  let flushing = false
  let timer: ReturnType<typeof setInterval> | undefined

  const emit = (type: EventType, data: TelemetryEvent['data']): void => {
    const now = Date.now()
    queue.push({ type, ts: now, route, data })
    saveSession(session.id, session.sampled, now)
    if (queue.shouldFlush(now)) void flush(false)
  }

  async function flush(unloading = false): Promise<void> {
    if (flushing && !unloading) return
    const now = Date.now()
    if (!queue.canSend(now) && !unloading) return
    flushing = true
    try {
      while (queue.size > 0) {
        const batch = queue.take()
        if (!batch.length) break
        const ok = await sendBatch(
          cfg.endpoint,
          { session_id: session.id, events: batch },
          { fetchFn: window.fetch.bind(window), sendBeacon: navigator.sendBeacon?.bind(navigator), getToken },
          unloading,
        )
        if (!ok) { queue.fail(batch, Date.now()); break }
        queue.ack()
        if (!unloading && queue.size < cfg.batch.maxEvents) break
      }
    } finally {
      flushing = false
    }
  }

  const reportAbandonedForms = (): void => {
    touchedForms.forEach((state, form) => {
      if (!state.submitted && state.fields.size > 0) {
        emit('form_abandon', {
          form: describeElement(form as unknown as ElementLike),
          fields_touched: state.fields.size,
          fields_total: form.querySelectorAll('input,select,textarea').length,
          last_field: state.last,
          ms_in_form: Date.now() - state.firstAt,
        })
      }
    })
    touchedForms.clear()
  }

  const sampleScroll = (): void => {
    const doc = document.documentElement
    const total = Math.max(doc.scrollHeight, 1)
    const pct = Math.min(100, Math.round(((window.scrollY + window.innerHeight) / total) * 100))
    if (pct > maxScrollPct) maxScrollPct = pct
  }

  const leavePage = (next?: string): void => {
    if (!pageOpen) return
    pageOpen = false
    sampleScroll() // a page that fits the viewport never scrolls, but was fully seen
    const snap = clock.snapshot(Date.now())
    reportAbandonedForms()
    emit('page_leave', {
      duration_ms: snap.durationMs,
      active_ms: snap.activeMs,
      idle_ms: snap.idleMs,
      scroll_max_pct: maxScrollPct,
      ...(next ? { route_next: next } : {}),
    })
  }

  const enterPage = (resumed: boolean): void => {
    pageOpen = true
    routeEnteredAt = Date.now()
    maxScrollPct = 0
    errorsThisPage = 0
    seenErrors.clear()
    clock.reset(routeEnteredAt)
    emit('page_view', {
      resumed,
      viewport_w: window.innerWidth,
      viewport_h: window.innerHeight,
      ...(document.referrer ? { referrer_host: safeHost(document.referrer) } : {}),
    })
  }

  const onRouteChange = (): void => {
    const next = sanitizeRoute(location.href)
    if (next === route) return
    leavePage(next)
    route = next
    dead.noteReaction()
    enterPage(false)
  }

  const dead = new DeadClickDetector(cfg.deadClickMs, hit => emit('dead_click', { selector: hit.target, wait_ms: hit.waitMs }))

  function start(): void {
    if (running) return
    running = true
    const on = <K extends keyof WindowEventMap>(t: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      window.addEventListener(t, fn as EventListener, opts)
      teardown.push(() => window.removeEventListener(t, fn as EventListener, opts as EventListenerOptions))
    }

    // Activity (active vs idle time).
    for (const t of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
      on(t, () => clock.input(Date.now()), { capture: true, passive: true })
    }

    // Clicks: rage and dead.
    on('click', e => {
      const el = e.target instanceof Element ? e.target : null
      if (!el || isExcluded(el as unknown as ElementLike)) return
      const target = describeElement(el as unknown as ElementLike)
      const hit = rage.onClick(target, Date.now(), route)
      if (hit) emit('rage_click', { selector: target, count: hit.count, window_ms: cfg.rage.windowMs, navigated: hit.navigated })
      const a = el.closest('a,button,summary,select,label,[role=button],[role=link]') ?? el
      if (isDeadClickCandidate(a.tagName, {
        type: a.getAttribute('type'), role: a.getAttribute('role'), target: a.getAttribute('target'),
        download: a.hasAttribute('download'), href: a.getAttribute('href'), disabled: (a as HTMLButtonElement).disabled === true,
      })) dead.onClick(describeElement(a as unknown as ElementLike))
    }, { capture: true, passive: true })

    // Anything the page does in response to a click cancels the dead-click timer.
    const mo = new MutationObserver(() => dead.noteReaction())
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })
    teardown.push(() => mo.disconnect())
    on('focusin', () => dead.noteReaction(), { capture: true })
    on('popstate', () => { dead.noteReaction(); onRouteChange() })

    // Scroll depth, throttled.
    let lastScroll = 0
    on('scroll', () => {
      const now = Date.now()
      if (now - lastScroll < cfg.scrollSampleMs) return
      lastScroll = now
      dead.noteReaction()
      sampleScroll()
    }, { passive: true, capture: true })

    // Forms: record which fields were touched, never what was typed.
    on('input', e => {
      const el = e.target instanceof Element ? e.target : null
      const form = el?.closest('form')
      if (!el || !form || isExcluded(el as unknown as ElementLike)) return
      const label = (el.getAttribute('name') || el.getAttribute('type') || el.tagName).toLowerCase().slice(0, 40)
      const state = touchedForms.get(form) ?? { fields: new Set<string>(), last: '', firstAt: Date.now(), submitted: false }
      state.fields.add(label)
      state.last = label
      touchedForms.set(form, state)
    }, { capture: true, passive: true })
    on('submit', e => {
      const form = e.target instanceof Element ? e.target : null
      const state = form ? touchedForms.get(form) : undefined
      if (state) state.submitted = true
    }, { capture: true })

    // Client errors.
    const reportError = (source: string, message: unknown, stack: unknown, filename: unknown): void => {
      if (errorsThisPage >= cfg.maxErrorsPerPage) return
      const msg = scrubText(typeof message === 'string' ? message : String((message as Error)?.message ?? message ?? ''), 300)
      const stk = scrubStack(stack)
      const fingerprint = `${source}:${msg.slice(0, 120)}:${stk.split('\n')[1]?.trim().slice(0, 80) ?? ''}`
      if (seenErrors.has(fingerprint)) return
      seenErrors.add(fingerprint)
      errorsThisPage++
      emit('client_error', { source, message: msg, stack: stk, filename: sanitizeRoute(String(filename ?? '')), fingerprint: simpleHash(fingerprint) })
    }
    on('error', e => reportError('error', e.message, (e.error as Error | undefined)?.stack, e.filename))
    on('unhandledrejection', e => {
      const r = e.reason as Error | undefined
      reportError('unhandledrejection', r?.message ?? String(e.reason), r?.stack, '')
    })

    // Network failures: fetch and XHR (the app's API layer uses XHR).
    const isOwn = (u: string) => u.includes('/api/analytics/')
    const origFetch = window.fetch
    window.fetch = async function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
      const t0 = Date.now()
      try {
        const res = await origFetch.call(window, input, init)
        if (!res.ok && !isOwn(url)) emit('net_fail', { method, path: sanitizeRoute(url), status: res.status, duration_ms: Date.now() - t0, kind: 'http' })
        return res
      } catch (err) {
        if (!isOwn(url)) emit('net_fail', { method, path: sanitizeRoute(url), status: 0, duration_ms: Date.now() - t0, kind: 'network' })
        throw err
      }
    }
    teardown.push(() => { window.fetch = origFetch })

    const proto = XMLHttpRequest.prototype
    const origOpen = proto.open
    const origSend = proto.send
    proto.open = function patchedOpen(this: XMLHttpRequest & { __tel?: { m: string; u: string } }, method: string, url: string | URL, ...rest: unknown[]) {
      this.__tel = { m: String(method).toUpperCase(), u: String(url) }
      return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
    } as typeof proto.open
    proto.send = function patchedSend(this: XMLHttpRequest & { __tel?: { m: string; u: string } }, body?: Document | XMLHttpRequestBodyInit | null) {
      const meta = this.__tel
      const t0 = Date.now()
      if (meta && !isOwn(meta.u)) {
        this.addEventListener('loadend', () => {
          if (this.status === 0 || this.status >= 400) {
            emit('net_fail', { method: meta.m, path: sanitizeRoute(meta.u), status: this.status, duration_ms: Date.now() - t0, kind: this.status === 0 ? 'network' : 'http' })
          }
        })
      }
      return origSend.call(this, body)
    }
    teardown.push(() => { proto.open = origOpen; proto.send = origSend })

    // SPA route changes.
    const origPush = history.pushState
    const origReplace = history.replaceState
    history.pushState = function (...a: Parameters<History['pushState']>) { const r = origPush.apply(this, a); onRouteChange(); return r }
    history.replaceState = function (...a: Parameters<History['replaceState']>) { const r = origReplace.apply(this, a); onRouteChange(); return r }
    teardown.push(() => { history.pushState = origPush; history.replaceState = origReplace })

    // Flush triggers: hidden / pagehide send what we have via beacon; coming back starts a new view.
    const onHidden = (): void => { leavePage(); void flush(true) }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') onHidden()
      else if (!pageOpen) enterPage(true)
    })
    on('pagehide', () => { if (document.visibilityState !== 'hidden') onHidden() })

    timer = setInterval(() => { void flush(false) }, cfg.batch.flushIntervalMs)
    teardown.push(() => timer && clearInterval(timer))

    enterPage(false)
  }

  function stop(): void {
    running = false
    teardown.splice(0).forEach(fn => fn())
  }

  void routeEnteredAt
  return { start, stop, flush }
}

function safeHost(url: string): string {
  try { return new URL(url).host.slice(0, 100) } catch { return '' }
}

function simpleHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16)
}
