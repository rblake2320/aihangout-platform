import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { api } from '../services/api'
import { useAuthStore } from '../stores/authStore'

const BIO_MAX = 500
const LINKS_MAX = 5
const AVATAR_MAX_BYTES = 512 * 1024
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp']

interface Link { label: string; url: string }

/** Settings > Public profile: avatar upload, bio and up to five links. The server re-validates everything. */
export default function ProfileEditor() {
  const username = useAuthStore(s => s.user?.username)
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [bio, setBio] = useState<string | null>(null)
  const [links, setLinks] = useState<Link[] | null>(null)

  const { data } = useQuery({
    queryKey: ['user', username],
    queryFn: async () => (await api.get(`/users/by-username/${username}`)).data,
    enabled: !!username,
  })
  const profile = data?.user
  const bioValue = bio ?? profile?.bio ?? ''
  const linksValue: Link[] = links ?? profile?.links ?? []
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['user', username] })

  const save = async () => {
    setBusy(true)
    try {
      await api.put('/users/me/profile', { bio: bioValue, links: linksValue.filter(l => l.label.trim() || l.url.trim()) })
      toast.success('Profile saved')
      setBio(null)
      setLinks(null)
      await refresh()
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } }).response?.data?.error
      toast.error(msg || 'Could not save your profile')
    } finally {
      setBusy(false)
    }
  }

  const upload = async (file: File | undefined) => {
    if (!file) return
    if (!AVATAR_TYPES.includes(file.type)) return void toast.error('Use a PNG, JPEG or WebP image')
    if (file.size > AVATAR_MAX_BYTES) return void toast.error('Image must be 512 KB or smaller')
    setBusy(true)
    try {
      await api.post('/users/me/avatar', file, { headers: { 'Content-Type': file.type } })
      toast.success('Avatar updated')
      await refresh()
    } catch (e) {
      const msg = (e as { response?: { data?: { error?: string } } }).response?.data?.error
      toast.error(msg || 'Could not upload the image')
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const removeAvatar = async () => {
    setBusy(true)
    try {
      await api.delete('/users/me/avatar')
      await refresh()
    } catch {
      toast.error('Could not remove the avatar')
    } finally {
      setBusy(false)
    }
  }

  const setLink = (i: number, patch: Partial<Link>) => setLinks(linksValue.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  return (
    <section aria-labelledby="profile-heading" className="mt-8 rounded-lg border border-gray-200 bg-white p-6">
      <h2 id="profile-heading" className="text-lg font-semibold text-gray-900">Public profile</h2>

      <div className="mt-4 flex items-center gap-4">
        {profile?.avatar_url
          ? <img src={profile.avatar_url} alt="Your avatar" width={64} height={64} className="h-16 w-16 rounded-full object-cover" />
          : <div className="flex h-16 w-16 items-center justify-center rounded-full bg-gray-200 text-xl text-gray-500" aria-hidden="true">{username?.[0]?.toUpperCase()}</div>}
        <div className="flex flex-col gap-2 sm:flex-row">
          <input ref={fileRef} type="file" accept={AVATAR_TYPES.join(',')} aria-label="Upload avatar" disabled={busy}
            onChange={e => void upload(e.target.files?.[0])} className="text-sm" />
          {profile?.avatar_url && (
            <button type="button" disabled={busy} onClick={removeAvatar} className="text-sm text-red-600 underline">Remove</button>
          )}
        </div>
      </div>
      <p className="mt-1 text-xs text-gray-500">PNG, JPEG or WebP, up to 512 KB.</p>

      <label htmlFor="bio" className="mt-6 block font-medium text-gray-900">Bio</label>
      <textarea id="bio" rows={4} maxLength={BIO_MAX} value={bioValue} onChange={e => setBio(e.target.value)}
        className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm" />
      <p className="text-xs text-gray-500">{bioValue.length}/{BIO_MAX}. Plain text; HTML is removed.</p>

      <p className="mt-6 font-medium text-gray-900">Links</p>
      <div className="mt-1 space-y-2">
        {linksValue.map((l, i) => (
          <div key={i} className="flex flex-col gap-2 sm:flex-row">
            <input aria-label={`Link ${i + 1} label`} maxLength={40} placeholder="Label" value={l.label}
              onChange={e => setLink(i, { label: e.target.value })} className="rounded-md border border-gray-300 px-3 py-2 text-sm sm:w-40" />
            <input aria-label={`Link ${i + 1} address`} maxLength={200} placeholder="https://" value={l.url}
              onChange={e => setLink(i, { url: e.target.value })} className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm" />
            <button type="button" onClick={() => setLinks(linksValue.filter((_, j) => j !== i))} className="text-sm text-red-600 underline">Remove</button>
          </div>
        ))}
      </div>
      {linksValue.length < LINKS_MAX && (
        <button type="button" onClick={() => setLinks([...linksValue, { label: '', url: '' }])} className="mt-2 text-sm text-blue-600 underline">
          Add a link
        </button>
      )}

      <div className="mt-6">
        <button type="button" disabled={busy} onClick={save}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          Save profile
        </button>
      </div>
    </section>
  )
}
