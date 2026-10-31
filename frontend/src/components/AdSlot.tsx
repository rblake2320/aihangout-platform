import { useEffect, useRef, useState } from 'react'
import { api } from '../services/api'
import { adEventsAllowed } from '../ads/consent'

// First-party ad slot (AIH-R9). The creative is data from /api/ads/serve, rendered by
// this component: no third-party script, iframe or pixel. Every ad carries its
// disclosure label. Impressions (half the slot visible for one second) and clicks are
// reported only with analytics consent, and carry no user data.
export type Placement = 'feed-inline' | 'problem-footer'

interface Ad {
  campaign_id: string
  placement: Placement
  kind: 'paid' | 'community' | 'house'
  label: string
  headline: string
  body: string | null
  cta: string | null
  image_url: string | null
  url: string
  rel: string | null
}

function sendEvent(ad: Ad, type: 'impression' | 'click', viewId: string) {
  if (!adEventsAllowed()) return
  void fetch('/api/ads/events?consent=analytics', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events: [{ type, campaign_id: ad.campaign_id, placement: ad.placement, view_id: viewId }] }),
  }).catch(() => { /* reporting is best-effort; the ad itself never depends on it */ })
}

export default function AdSlot({ placement, tags = [] }: { placement: Placement; tags?: string[] }) {
  const [ad, setAd] = useState<Ad | null>(null)
  const ref = useRef<HTMLElement | null>(null)
  const viewId = useRef(`v${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`)
  const tagKey = tags.join(',')

  useEffect(() => {
    let cancelled = false
    api.get('/ads/serve', { params: { placement, tags: tagKey || undefined } })
      .then(res => { if (!cancelled) setAd(res.data?.ad || null) })
      .catch(() => { if (!cancelled) setAd(null) })
    return () => { cancelled = true }
  }, [placement, tagKey])

  useEffect(() => {
    if (!ad || !ref.current || typeof IntersectionObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | undefined
    let counted = false
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !counted) {
        timer = setTimeout(() => { counted = true; sendEvent(ad, 'impression', viewId.current); observer.disconnect() }, 1000)
      } else if (timer) {
        clearTimeout(timer)
      }
    }, { threshold: 0.5 })
    observer.observe(ref.current)
    return () => { observer.disconnect(); if (timer) clearTimeout(timer) }
  }, [ad])

  if (!ad) return null
  const external = /^https:/i.test(ad.url)

  return (
    <aside
      ref={ref}
      aria-label={ad.label}
      data-placement={placement}
      data-campaign={ad.campaign_id}
      className="bg-white rounded-lg border border-dashed border-gray-300 p-4"
    >
      <p className="text-xs font-medium uppercase tracking-wide text-gray-400 mb-2">{ad.label}</p>
      <div className="flex items-start gap-4">
        {ad.image_url && (
          <img src={ad.image_url} alt="" loading="lazy" className="w-16 h-16 rounded object-cover flex-shrink-0" />
        )}
        <div className="min-w-0">
          <p className="font-semibold text-gray-900">{ad.headline}</p>
          {ad.body && <p className="text-sm text-gray-600 mt-1">{ad.body}</p>}
          <a
            href={ad.url}
            {...(external ? { target: '_blank', rel: ad.rel || 'noopener noreferrer' } : {})}
            onClick={() => sendEvent(ad, 'click', viewId.current)}
            className="inline-block mt-2 text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            {ad.cta || 'Learn more'}
          </a>
        </div>
      </div>
    </aside>
  )
}
