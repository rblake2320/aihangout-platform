import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { api } from '../services/api'
import { useAuthStore } from '../stores/authStore'
import { analyticsAllowed, onConsentChange, optOutSignalPresent, setAnalyticsConsent } from '../consent'

/** Settings > Privacy and data: analytics choice, data export, account deletion. */
export default function PrivacyControls() {
  const navigate = useNavigate()
  const token = useAuthStore(s => s.token)
  const logout = useAuthStore(s => s.logout)
  const [analytics, setAnalytics] = useState(() => analyticsAllowed())
  const [busy, setBusy] = useState(false)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const signal = optOutSignalPresent()

  useEffect(() => onConsentChange(() => setAnalytics(analyticsAllowed())), [])

  const download = async () => {
    setBusy(true)
    try {
      const res = await api.get('/me/export', { responseType: 'blob' })
      const url = URL.createObjectURL(res.data as Blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'aihangout-export.json'
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      toast.error('Could not export your data. Try again in a minute.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await api.delete('/me', { data: { password, confirm } })
      toast.success('Your account has been deleted.')
      logout()
      navigate('/')
    } catch (e) {
      const status = (e as { response?: { status?: number } }).response?.status
      toast.error(status === 403 ? 'Password incorrect, or this account cannot be deleted yet.' : 'Could not delete the account.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="privacy-heading" className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
      <h2 id="privacy-heading" className="text-lg font-semibold text-gray-900">Privacy and data</h2>

      <div className="mt-4 flex items-center justify-between gap-4">
        <div>
          <p className="font-medium text-gray-900">Usage analytics</p>
          <p className="text-sm text-gray-500">
            {signal
              ? 'Your browser sends Do Not Track / Global Privacy Control, so analytics stay off.'
              : 'Pages viewed, time on page, dead clicks and errors, to fix the site. Off until you allow it.'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={analytics}
          disabled={signal}
          onClick={() => setAnalyticsConsent(!analytics, 'settings', token)}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full ${analytics ? 'bg-blue-600' : 'bg-gray-300'} disabled:opacity-50`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${analytics ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
      </div>

      <div className="mt-6 border-t border-gray-100 pt-4">
        <p className="font-medium text-gray-900">Download my data</p>
        <p className="text-sm text-gray-500">Everything we hold about you as one JSON file (credentials excluded).</p>
        <button type="button" disabled={busy} onClick={download}
          className="mt-2 rounded-md border border-blue-600 px-3 py-2 text-sm font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50">
          Download JSON
        </button>
      </div>

      <div className="mt-6 border-t border-gray-100 pt-4">
        <p className="font-medium text-red-700">Delete my account</p>
        <p className="text-sm text-gray-500">
          Removes your sessions, votes, bookmarks, follows, notifications, chat messages and analytics, and replaces your
          username and email. Problems and solutions you posted stay, shown as &quot;deleted-user&quot;. This cannot be undone.
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input type="password" autoComplete="current-password" placeholder="Password" value={password}
            onChange={e => setPassword(e.target.value)} className="rounded-md border border-gray-300 px-3 py-2 text-sm" />
          <input type="text" placeholder="Type DELETE" value={confirm}
            onChange={e => setConfirm(e.target.value)} className="rounded-md border border-gray-300 px-3 py-2 text-sm" />
          <button type="button" disabled={busy || !password || confirm !== 'DELETE'} onClick={remove}
            className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50">
            Delete account
          </button>
        </div>
      </div>
    </section>
  )
}
