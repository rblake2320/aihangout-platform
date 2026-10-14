import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '../stores/authStore'
import api from '../services/api'
import LiveProfileAvatar from './LiveProfileAvatar'

export default function LiveProfileSettings() {
  const {user} = useAuthStore()
  const queryClient = useQueryClient()
  const [link, setLink] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  async function save(remove = false) {
    setBusy(true)
    try {
      let profileId: string | null = null
      if (!remove) {
        const parsed = new URL(link)
        if (parsed.origin !== 'https://electionclock.com' || !['/live-avatar','/live-avatar.html'].includes(parsed.pathname)) throw new Error('Paste the live avatar URL from electionclock.com.')
        profileId = parsed.searchParams.get('id')
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(profileId || '')) throw new Error('The link needs a valid profile ID.')
      }
      await api.put('/users/me/live-profile', {profileId})
      await queryClient.invalidateQueries({queryKey:['live-profile', user?.username]})
      setMessage(remove ? 'Live countdown removed.' : 'Live countdown linked. Your current profile setting also applies to earlier posts.')
    } catch(error: any) { setMessage(error.response?.data?.error || error.message || 'Could not save live countdown.') }
    finally {setBusy(false)}
  }
  return <section className="rounded-lg border border-gray-200 bg-white p-6 space-y-4">
    <h2 className="text-lg font-semibold text-gray-900">Live countdown picture</h2>
    <div className="flex items-center gap-4"><LiveProfileAvatar username={user?.username || ''} size={64}/>
      <p className="text-sm text-gray-600">Enable your countdown in <a className="text-blue-700 underline" href="https://electionclock.com/#/profile" target="_blank" rel="noopener noreferrer">Election Countdown profile settings</a>, then paste its live avatar link here.</p></div>
    <label className="block text-sm font-medium">Live avatar URL<input aria-label="Live avatar URL" value={link} onChange={e=>setLink(e.target.value)} placeholder="https://electionclock.com/live-avatar?id=…" className="mt-1 w-full rounded border border-gray-300 p-2" /></label>
    <p className="text-sm text-gray-600">Your countdown's selected device supplies its time zone. Keep its settings page open on that device for updates. If the stream is unavailable, your initial appears instead.</p>
    <div className="flex gap-3"><button disabled={busy} onClick={()=>void save()} className="rounded bg-blue-700 px-4 py-2 text-white disabled:opacity-50">Link countdown</button>
      <button disabled={busy} onClick={()=>void save(true)} className="rounded border border-gray-300 px-4 py-2 disabled:opacity-50">Remove countdown</button></div>
    <p role="status" className="text-sm">{message}</p>
  </section>
}
