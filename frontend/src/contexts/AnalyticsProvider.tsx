import { createContext, useEffect, useRef, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { analyticsTracker } from '../services/analytics'

interface AnalyticsContextValue {
  track: (eventType: string, metadata?: Record<string, any>) => void
}

export const AnalyticsContext = createContext<AnalyticsContextValue>({
  track: () => {}
})

export function AnalyticsProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const prevPath = useRef(location.pathname)
  const pageEnterTime = useRef(Date.now())
  const lastClickTime = useRef(0)

  // Track route changes
  useEffect(() => {
    const now = Date.now()
    const timeOnPrevious = now - pageEnterTime.current

    if (prevPath.current !== location.pathname) {
      // Emit time_on_page for previous page
      analyticsTracker.track('time_on_page', {
        page_url: prevPath.current,
        duration_ms: timeOnPrevious
      })
    }

    // Emit page_view for new page
    analyticsTracker.track('page_view', {
      from_url: prevPath.current,
      to_url: location.pathname,
      time_on_previous_ms: prevPath.current !== location.pathname ? timeOnPrevious : 0
    })

    prevPath.current = location.pathname
    pageEnterTime.current = now
  }, [location.pathname])

  // Track clicks via event delegation
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target || target.tagName === 'HTML' || target.tagName === 'BODY') return

      // Debounce rapid clicks (<200ms)
      const now = Date.now()
      if (now - lastClickTime.current < 200) return
      lastClickTime.current = now

      analyticsTracker.track('click', {
        tag: target.tagName.toLowerCase(),
        id: target.id || undefined,
        className: target.className ? String(target.className).slice(0, 100) : undefined,
        text: target.textContent?.trim().slice(0, 50) || undefined,
        href: (target as HTMLAnchorElement).href || undefined
      })
    }

    document.addEventListener('click', handleClick, { passive: true })
    return () => document.removeEventListener('click', handleClick)
  }, [])

  // Emit time_on_page on unmount (tab close handled by sendBeacon in analytics.ts)
  useEffect(() => {
    return () => {
      analyticsTracker.track('time_on_page', {
        page_url: prevPath.current,
        duration_ms: Date.now() - pageEnterTime.current
      })
    }
  }, [])

  const track = (eventType: string, metadata: Record<string, any> = {}) => {
    analyticsTracker.track(eventType, metadata)
  }

  return (
    <AnalyticsContext.Provider value={{ track }}>
      {children}
    </AnalyticsContext.Provider>
  )
}
