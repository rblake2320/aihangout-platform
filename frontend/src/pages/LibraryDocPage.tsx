import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../services/api'

interface Version {
  version: number
  citation_id: string
  file_type: 'pdf' | 'md'
  file_bytes: number
  sha256: string
  changelog: string
  download_count: number
  download_url: string
  created_at: string
}

const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`)

export default function LibraryDocPage() {
  const { ref } = useParams<{ ref: string }>()
  const { data, isLoading, isError } = useQuery({
    queryKey: ['library-doc', ref],
    queryFn: async () => (await api.get(`/library/${encodeURIComponent(ref ?? '')}`)).data.document,
    enabled: !!ref,
    retry: false,
  })

  if (isLoading) return <p role="status">Loading…</p>
  if (isError || !data) {
    return (
      <div className="mx-auto max-w-3xl">
        <p role="alert">Document not found.</p>
        <Link to="/library" className="text-blue-600 underline">Back to the library</Link>
      </div>
    )
  }
  const versions: Version[] = [...data.versions].reverse()

  return (
    <article className="mx-auto max-w-3xl space-y-6">
      <Link to="/library" className="text-sm text-blue-600 underline">Library</Link>
      <header>
        <h1 className="text-2xl font-bold text-gray-900">{data.title}</h1>
        <p className="text-gray-600">{data.authors.join(', ')}</p>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
          <div><dt className="text-gray-500">Cite as</dt><dd className="font-mono">{data.citation_id}</dd></div>
          <div><dt className="text-gray-500">Latest</dt><dd>v{data.latest_version}</dd></div>
          <div><dt className="text-gray-500">Licence</dt><dd>{data.license}</dd></div>
          <div><dt className="text-gray-500">Downloads</dt><dd>{data.download_count}</dd></div>
        </dl>
      </header>

      <section aria-labelledby="abstract-h">
        <h2 id="abstract-h" className="text-lg font-semibold">Abstract</h2>
        <p className="mt-1 whitespace-pre-line text-gray-700">{data.abstract}</p>
      </section>

      <section aria-labelledby="versions-h">
        <h2 id="versions-h" className="text-lg font-semibold">Versions</h2>
        <ul className="mt-2 space-y-3">
          {versions.map(v => (
            <li key={v.version} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="font-medium">v{v.version} <span className="font-mono text-xs text-gray-500">{v.citation_id}</span></p>
                <a href={v.download_url} download className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700">
                  Download {v.file_type.toUpperCase()} ({size(v.file_bytes)})
                </a>
              </div>
              {v.changelog && <p className="mt-1 text-sm text-gray-700">{v.changelog}</p>}
              <p className="mt-1 break-all text-xs text-gray-500">SHA-256 {v.sha256} · {v.download_count} downloads · {v.created_at}</p>
            </li>
          ))}
        </ul>
      </section>
    </article>
  )
}
