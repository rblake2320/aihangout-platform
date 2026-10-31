import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { needsBanner, onConsentChange, setAnalyticsConsent } from '../consent'
import { useAuthStore } from '../stores/authStore'

/** First-visit choice. Equal weight on both buttons; nothing is collected until "Allow". */
export default function ConsentBanner() {
  const [open, setOpen] = useState(() => needsBanner())
  const token = useAuthStore(s => s.token)

  useEffect(() => onConsentChange(() => setOpen(needsBanner())), [])
  if (!open) return null

  const decide = (analytics: boolean) => {
    setAnalyticsConsent(analytics, 'banner', token)
    setOpen(false)
  }

  return (
    <div
      role="dialog"
      aria-label="Privacy choices"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-gray-200 bg-white shadow-lg"
    >
      <div className="container mx-auto flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-700">
          We use first-party analytics (pages viewed, time on page, clicks that do nothing, errors) to fix the site.
          Nothing is collected until you choose. Account and security logs are separate and always on.{' '}
          <Link to="/privacy" className="text-blue-600 underline">Privacy policy</Link>
        </p>
        <div className="flex shrink-0 gap-3">
          <button
            type="button"
            onClick={() => decide(false)}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => decide(true)}
            className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
          >
            Allow analytics
          </button>
        </div>
      </div>
    </div>
  )
}
