import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BookmarkSlashIcon } from '@heroicons/react/24/outline'
import { bookmarksAPI } from '../services/api'
import { formatDistanceToNow } from 'date-fns'
import { parseApiDate } from '../utils/date'
import toast from 'react-hot-toast'

export default function BookmarksPage() {
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['bookmarks'],
    queryFn: () => bookmarksAPI.list(),
  })

  const removeMutation = useMutation({
    mutationFn: ({ type, id }: { type: string; id: number }) => bookmarksAPI.remove(type, id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bookmarks'] })
      toast.success('Bookmark removed')
    },
    onError: () => {
      toast.error('Failed to remove bookmark')
    },
  })

  const bookmarks = data?.data?.bookmarks || []
  const grouped = bookmarks.reduce((acc: any, b: any) => {
    if (!acc[b.content_type]) acc[b.content_type] = []
    acc[b.content_type].push(b)
    return acc
  }, {})

  const typeLabel: Record<string, string> = {
    problem: 'Problems',
    solution: 'Solutions',
    learning: 'Learning',
  }

  function getLink(b: any) {
    if (b.content_type === 'problem') return `/problem/${b.content_id}`
    if (b.content_type === 'solution') return `/problem/${b.content_id}`
    if (b.content_type === 'learning') return `/learning/${b.content_id}`
    return '/'
  }

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">My Bookmarks</h1>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-4 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
              <div className="h-3 bg-gray-200 rounded w-1/4" />
            </div>
          ))}
        </div>
      ) : bookmarks.length === 0 ? (
        <div className="text-center py-16 text-gray-500">
          <BookmarkSlashIcon className="w-12 h-12 mx-auto mb-3 text-gray-300" />
          <p>No bookmarks yet. Star a problem to save it here.</p>
        </div>
      ) : (
        Object.entries(grouped).map(([type, items]: any) => (
          <div key={type}>
            <h2 className="text-lg font-semibold text-gray-700 mb-3">{typeLabel[type] || type}</h2>
            <div className="space-y-3">
              {items.map((b: any) => (
                <div key={b.id} className="bg-white rounded-lg border border-gray-200 p-4 flex items-start justify-between gap-4">
                  <Link to={getLink(b)} className="flex-1 min-w-0 hover:text-blue-600">
                    <p className="font-medium text-gray-900 line-clamp-1">{b.title || 'Untitled'}</p>
                    {b.description && (
                      <p className="text-sm text-gray-500 mt-1 line-clamp-2">{b.description}</p>
                    )}
                    <p className="text-xs text-gray-400 mt-2">
                      Saved {formatDistanceToNow(parseApiDate(b.created_at), { addSuffix: true })}
                    </p>
                  </Link>
                  <button
                    onClick={() => removeMutation.mutate({ type: b.content_type, id: b.content_id })}
                    disabled={removeMutation.isPending}
                    className="flex-shrink-0 text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}
