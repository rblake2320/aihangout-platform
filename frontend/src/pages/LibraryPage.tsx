import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { api } from '../services/api'
import { useAuthStore } from '../stores/authStore'

const LICENSES = ['CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0', 'MIT', 'Apache-2.0', 'All-Rights-Reserved']
const PAGE = 20

export interface LibraryDoc {
  id: number
  citation_id: string
  title: string
  abstract: string
  authors: string[]
  license: string
  latest_version: number
  download_count: number
  created_at: string
}

function UploadForm({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api.post('/library', new FormData(e.currentTarget))
      toast.success('Published')
      e.currentTarget.reset()
      onDone()
    } catch (err) {
      toast.error((err as { response?: { data?: { error?: string } } }).response?.data?.error || 'Could not publish')
    } finally {
      setBusy(false)
    }
  }
  const input = 'w-full rounded-md border border-gray-300 px-3 py-2 text-sm'
  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="font-semibold text-gray-900">Publish a document (admin)</h2>
      <input name="title" required maxLength={200} placeholder="Title" aria-label="Title" className={input} />
      <textarea name="abstract" required maxLength={2000} rows={3} placeholder="Abstract" aria-label="Abstract" className={input} />
      <input name="authors" required placeholder="Authors, comma separated" aria-label="Authors" className={input} />
      <select name="license" required defaultValue="CC-BY-4.0" aria-label="Licence" className={input}>
        {LICENSES.map(l => <option key={l}>{l}</option>)}
      </select>
      <input name="file" type="file" required accept=".pdf,.md,application/pdf,text/markdown" aria-label="File (PDF or Markdown, up to 10 MB)" className="text-sm" />
      <button disabled={busy} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Publish</button>
    </form>
  )
}

export default function LibraryPage() {
  const isAdmin = useAuthStore(s => !!s.user?.is_admin)
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const [term, setTerm] = useState('')
  const [page, setPage] = useState(0)

  const { data, isLoading, isError } = useQuery({
    queryKey: ['library', term, page],
    queryFn: async () => (await api.get('/library', { params: { q: term || undefined, limit: PAGE, offset: page * PAGE } })).data,
  })
  const docs: LibraryDoc[] = data?.documents ?? []
  const total: number = data?.total ?? 0

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Library</h1>
        <p className="text-sm text-gray-600">White papers and reference documents, each with a citation ID, versions and a licence.</p>
      </header>

      <form onSubmit={e => { e.preventDefault(); setPage(0); setTerm(q.trim()) }} className="flex gap-2" role="search">
        <input value={q} onChange={e => setQ(e.target.value)} maxLength={200} aria-label="Search the library" placeholder="Title, author, abstract or AIH-LIB id"
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm" />
        <button className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium">Search</button>
      </form>

      {isAdmin && <UploadForm onDone={() => queryClient.invalidateQueries({ queryKey: ['library'] })} />}

      {isLoading && <p role="status">Loading…</p>}
      {isError && <p role="alert" className="text-red-700">Could not load the library.</p>}
      {!isLoading && !isError && docs.length === 0 && <p className="text-gray-600">No documents found.</p>}

      <ul className="space-y-3">
        {docs.map(d => (
          <li key={d.id} className="rounded-lg border border-gray-200 bg-white p-4">
            <Link to={`/library/${d.citation_id}`} className="text-lg font-semibold text-blue-700 hover:underline">{d.title}</Link>
            <p className="text-sm text-gray-500">{d.authors.join(', ')} · {d.citation_id} · v{d.latest_version} · {d.license}</p>
            <p className="mt-2 line-clamp-3 text-sm text-gray-700">{d.abstract}</p>
            <p className="mt-1 text-xs text-gray-500">{d.download_count} downloads</p>
          </li>
        ))}
      </ul>

      {total > PAGE && (
        <nav className="flex justify-between text-sm" aria-label="Pagination">
          <button disabled={page === 0} onClick={() => setPage(p => p - 1)} className="underline disabled:opacity-40">Previous</button>
          <span>{page * PAGE + 1}–{Math.min((page + 1) * PAGE, total)} of {total}</span>
          <button disabled={(page + 1) * PAGE >= total} onClick={() => setPage(p => p + 1)} className="underline disabled:opacity-40">Next</button>
        </nav>
      )}
    </div>
  )
}
