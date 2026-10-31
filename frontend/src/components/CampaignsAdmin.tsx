import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { api } from '../services/api'

// Admin Campaigns tab (AIH-R9): house ads, community slots and paid sponsorships.
type Campaign = {
  id: string; name: string; advertiser: string; kind: 'paid' | 'community' | 'house'
  status: 'draft' | 'active' | 'paused' | 'ended'; placements: string[]; target_tags: string[]
  headline: string; body: string | null; cta: string | null; image_url: string | null; click_url: string
  priority: number; weight: number; starts_at: string | null; ends_at: string | null
  impressions: number; clicks: number; ctr: number | null
}
type Placement = { id: string; label: string }

const EMPTY = {
  name: '', advertiser: '', kind: 'paid', status: 'draft', placements: ['problem-footer'] as string[],
  target_tags: '', headline: '', body: '', cta: '', click_url: 'https://', image_url: '',
  priority: 0, weight: 1, starts_at: '', ends_at: '',
}

const input = 'w-full border border-gray-300 rounded px-2 py-1 text-sm'

export default function CampaignsAdmin() {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ ...EMPTY })
  const [showForm, setShowForm] = useState(false)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin-campaigns'],
    queryFn: async () => (await api.get('/admin/campaigns')).data as { campaigns: Campaign[]; placements: Placement[] },
  })

  const errorText = (e: any) => e?.response?.data?.error || 'Request failed'
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-campaigns'] })

  const create = useMutation({
    mutationFn: () => api.post('/admin/campaigns', {
      ...form,
      target_tags: form.target_tags.split(',').map(t => t.trim()).filter(Boolean),
      image_url: form.image_url || null,
      starts_at: form.starts_at || null,
      ends_at: form.ends_at || null,
      priority: Number(form.priority),
      weight: Number(form.weight),
    }),
    onSuccess: () => { toast.success('Campaign created'); setForm({ ...EMPTY }); setShowForm(false); refresh() },
    onError: (e) => toast.error(errorText(e)),
  })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Campaign['status'] }) => api.put(`/admin/campaigns/${id}`, { status }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorText(e)),
  })

  if (isLoading) return <p className="text-gray-500">Loading campaigns…</p>
  if (isError || !data) return <p className="text-red-600">Could not load campaigns.</p>
  const set = (k: string, v: any) => setForm(f => ({ ...f, [k]: v }))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">
          Fill order: paid, then community, then house ads. Targeting is by page tag only. Events are counted only with analytics consent.
        </p>
        <button onClick={() => setShowForm(s => !s)} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700">
          {showForm ? 'Cancel' : 'New campaign'}
        </button>
      </div>

      {showForm && (
        <form
          onSubmit={(e) => { e.preventDefault(); create.mutate() }}
          className="bg-white border border-gray-200 rounded-lg p-4 grid grid-cols-1 md:grid-cols-2 gap-3"
        >
          <label className="text-sm">Name<input className={input} value={form.name} onChange={e => set('name', e.target.value)} required /></label>
          <label className="text-sm">Advertiser<input className={input} value={form.advertiser} onChange={e => set('advertiser', e.target.value)} required /></label>
          <label className="text-sm">Kind
            <select className={input} value={form.kind} onChange={e => set('kind', e.target.value)}>
              <option value="paid">paid (sponsorship)</option><option value="community">community</option><option value="house">house</option>
            </select>
          </label>
          <label className="text-sm">Status
            <select className={input} value={form.status} onChange={e => set('status', e.target.value)}>
              <option value="draft">draft</option><option value="active">active</option><option value="paused">paused</option>
            </select>
          </label>
          <fieldset className="text-sm md:col-span-2">
            <legend>Placements</legend>
            {data.placements.map(p => (
              <label key={p.id} className="mr-4">
                <input
                  type="checkbox"
                  checked={form.placements.includes(p.id)}
                  onChange={e => set('placements', e.target.checked ? [...form.placements, p.id] : form.placements.filter(x => x !== p.id))}
                /> {p.id} <span className="text-gray-400">({p.label})</span>
              </label>
            ))}
          </fieldset>
          <label className="text-sm md:col-span-2">Target tags (comma separated, empty = every page)<input className={input} value={form.target_tags} onChange={e => set('target_tags', e.target.value)} /></label>
          <label className="text-sm md:col-span-2">Headline<input className={input} maxLength={90} value={form.headline} onChange={e => set('headline', e.target.value)} required /></label>
          <label className="text-sm md:col-span-2">Body<input className={input} maxLength={240} value={form.body} onChange={e => set('body', e.target.value)} /></label>
          <label className="text-sm">Call to action<input className={input} maxLength={30} value={form.cta} onChange={e => set('cta', e.target.value)} /></label>
          <label className="text-sm">Link (https:// or /path)<input className={input} value={form.click_url} onChange={e => set('click_url', e.target.value)} required /></label>
          <label className="text-sm">Image URL (https, optional)<input className={input} value={form.image_url} onChange={e => set('image_url', e.target.value)} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">Priority<input type="number" className={input} value={form.priority} onChange={e => set('priority', e.target.value)} /></label>
            <label className="text-sm">Weight<input type="number" min={1} className={input} value={form.weight} onChange={e => set('weight', e.target.value)} /></label>
          </div>
          <label className="text-sm">Starts (UTC)<input type="datetime-local" className={input} value={form.starts_at} onChange={e => set('starts_at', e.target.value)} /></label>
          <label className="text-sm">Ends (UTC)<input type="datetime-local" className={input} value={form.ends_at} onChange={e => set('ends_at', e.target.value)} /></label>
          <div className="md:col-span-2">
            <button type="submit" disabled={create.isPending} className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">Create campaign</button>
          </div>
        </form>
      )}

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm bg-white border border-gray-200 rounded-lg">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-3 py-2">Campaign</th><th className="px-3 py-2">Kind</th><th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Placements / tags</th><th className="px-3 py-2">Schedule</th>
              <th className="px-3 py-2 text-right">Impr.</th><th className="px-3 py-2 text-right">Clicks</th><th className="px-3 py-2 text-right">CTR</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {data.campaigns.map(c => (
              <tr key={c.id} className="border-t border-gray-100 align-top">
                <td className="px-3 py-2">
                  <p className="font-medium text-gray-900">{c.name}</p>
                  <p className="text-xs text-gray-500">{c.advertiser} · {c.headline}</p>
                </td>
                <td className="px-3 py-2">{c.kind}</td>
                <td className="px-3 py-2">{c.status}</td>
                <td className="px-3 py-2 text-xs">{c.placements.join(', ')}<br /><span className="text-gray-500">{c.target_tags.length ? c.target_tags.join(', ') : 'all pages'}</span></td>
                <td className="px-3 py-2 text-xs text-gray-500">{c.starts_at || '—'} → {c.ends_at || 'open'}</td>
                <td className="px-3 py-2 text-right">{c.impressions}</td>
                <td className="px-3 py-2 text-right">{c.clicks}</td>
                <td className="px-3 py-2 text-right">{c.ctr == null ? '—' : `${(c.ctr * 100).toFixed(1)}%`}</td>
                <td className="px-3 py-2">
                  {c.status === 'active'
                    ? <button onClick={() => setStatus.mutate({ id: c.id, status: 'paused' })} className="text-xs text-gray-600 hover:text-gray-900">Pause</button>
                    : c.status !== 'ended' && <button onClick={() => setStatus.mutate({ id: c.id, status: 'active' })} className="text-xs text-blue-600 hover:text-blue-800">Activate</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
