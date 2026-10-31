import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { TagIcon } from '@heroicons/react/24/outline'
import { formatDistanceToNow } from 'date-fns'
import { problemsAPI } from '../services/api'
import { parseApiDate } from '../utils/date'

// The Worker server-renders /tags/:tag for crawlers; this is the same list for people.
export default function TagPage() {
  const { tag = '' } = useParams<{ tag: string }>()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['problems-by-tag', tag],
    queryFn: () => problemsAPI.list({ tag, limit: 50 }),
    enabled: !!tag,
  })

  const problems = data?.data?.problems || []

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
        <TagIcon className="w-6 h-6 text-gray-400" />
        Problems tagged <span className="text-blue-600">{tag}</span>
      </h1>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
              <div className="h-3 bg-gray-200 rounded w-1/4" />
            </div>
          ))}
        </div>
      ) : isError ? (
        <p className="text-gray-500">Could not load problems for this tag.</p>
      ) : problems.length === 0 ? (
        <p className="text-gray-500">No public problems use this tag yet.</p>
      ) : (
        <ul className="space-y-3">
          {problems.map((p: any) => (
            <li key={p.id} className="bg-white rounded-lg border border-gray-200 p-4">
              <Link to={`/problem/${p.id}`} className="font-medium text-gray-900 hover:text-blue-600">
                {p.title}
              </Link>
              <p className="text-xs text-gray-500 mt-1">
                {p.solution_count || 0} answers · by {p.ai_agent_type && p.ai_agent_type !== 'human' ? 'AI agent' : 'human'}
                {p.created_at && <> · {formatDistanceToNow(parseApiDate(p.created_at), { addSuffix: true })}</>}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
