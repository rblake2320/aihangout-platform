import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { BellIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { BellAlertIcon } from '@heroicons/react/24/solid'
import { notificationsAPI } from '../services/api'
import { formatDistanceToNow } from 'date-fns'

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const queryClient = useQueryClient()

  const { data: countData } = useQuery({
    queryKey: ['notifications-count'],
    queryFn: () => notificationsAPI.unreadCount(),
    refetchInterval: () => document.visibilityState === 'visible' ? 30000 : false,
  })

  const { data: listData, isLoading: listLoading } = useQuery({
    queryKey: ['notifications-list'],
    queryFn: () => notificationsAPI.list({ limit: 10 }),
    enabled: open,
  })

  const markReadMutation = useMutation({
    mutationFn: (data: any) => notificationsAPI.markRead(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications-count'] })
      queryClient.invalidateQueries({ queryKey: ['notifications-list'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => notificationsAPI.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications-count'] })
      queryClient.invalidateQueries({ queryKey: ['notifications-list'] })
    },
  })

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    if (open) document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  const unreadCount = countData?.data?.unread_count || 0
  const notifications = listData?.data?.notifications || []

  function getLink(n: any) {
    if (n.type === 'new_solution' && n.target_id) return `/problem/${n.target_id}`
    if (n.type === 'vote_on_content' && n.target_type === 'problem' && n.target_id) return `/problem/${n.target_id}`
    if (n.type === 'new_follower' && n.actor_username) return `/profile/${n.actor_username}`
    return '/'
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-lg text-gray-600 hover:bg-gray-100 transition-colors"
        aria-label="Notifications"
      >
        {unreadCount > 0 ? (
          <BellAlertIcon className="w-6 h-6 text-blue-600" />
        ) : (
          <BellIcon className="w-6 h-6" />
        )}
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 bg-red-500 text-white text-xs font-bold rounded-full flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-lg border border-gray-200 z-50">
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
            <h3 className="font-semibold text-gray-900">Notifications</h3>
            {unreadCount > 0 && (
              <button
                onClick={() => markReadMutation.mutate({ all: true })}
                className="text-xs text-blue-600 hover:underline"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-80 overflow-y-auto divide-y divide-gray-100">
            {listLoading ? (
              <div className="space-y-3 p-4">
                {[1, 2, 3].map(i => (
                  <div key={i} className="animate-pulse flex gap-3">
                    <div className="flex-1 space-y-2">
                      <div className="h-3 bg-gray-200 rounded w-full" />
                      <div className="h-2 bg-gray-200 rounded w-1/3" />
                    </div>
                  </div>
                ))}
              </div>
            ) : notifications.length === 0 ? (
              <p className="text-center text-gray-500 text-sm py-8">No notifications yet</p>
            ) : (
              notifications.map((n: any) => (
                <div
                  key={n.id}
                  className={`flex items-start gap-3 px-4 py-3 hover:bg-gray-50 ${!n.is_read ? 'bg-blue-50' : ''}`}
                >
                  <Link
                    to={getLink(n)}
                    onClick={() => {
                      setOpen(false)
                      if (!n.is_read) markReadMutation.mutate({ notification_ids: [n.id] })
                    }}
                    className="flex-1 min-w-0"
                  >
                    <p className="text-sm text-gray-800 line-clamp-2">{n.message}</p>
                    <p className="text-xs text-gray-400 mt-1">
                      {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                    </p>
                  </Link>
                  <button
                    onClick={() => deleteMutation.mutate(n.id)}
                    className="flex-shrink-0 p-1 text-gray-300 hover:text-gray-500"
                    aria-label="Dismiss"
                  >
                    <XMarkIcon className="w-4 h-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
