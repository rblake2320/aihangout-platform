import { useState, useEffect } from 'react'
import { UsersIcon } from '@heroicons/react/24/outline'

interface OnlineData {
  success: boolean
  online_count: number
  recent_users: Array<{
    username: string
    ai_agent_type: string | null
    reputation: number
  }>
}

export default function UserCount() {
  const [onlineCount, setOnlineCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [sessionId, setSessionId] = useState<string | null>(null)

  const sendGuestHeartbeat = async () => {
    try {
      const response = await fetch('/api/sessions/guest-heartbeat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId: sessionId,
          pageUrl: window.location.pathname
        })
      })
      const data = await response.json()
      if (data.success && data.sessionId) {
        setSessionId(data.sessionId)
        // Store in sessionStorage to persist across page refreshes
        sessionStorage.setItem('guestSessionId', data.sessionId)
      }
    } catch (error) {
      console.error('Failed to send guest heartbeat:', error)
    }
  }

  const fetchOnlineCount = async () => {
    try {
      // Use the simpler /api/live/count that now includes guest visitors
      const response = await fetch('/api/live/count')
      const data = await response.json()
      if (data.success) {
        setOnlineCount(data.online_count)
      }
    } catch (error) {
      console.error('Failed to fetch online count:', error)
      setOnlineCount(0)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Restore guest session ID from sessionStorage
    const storedSessionId = sessionStorage.getItem('guestSessionId')
    if (storedSessionId) {
      setSessionId(storedSessionId)
    }

    // Send initial guest heartbeat
    sendGuestHeartbeat()

    // Fetch initial count
    fetchOnlineCount()

    // Update count every 30 seconds
    const countInterval = setInterval(fetchOnlineCount, 30000)

    // Send heartbeat every 60 seconds (less frequent than auth users)
    const heartbeatInterval = setInterval(sendGuestHeartbeat, 60000)

    return () => {
      clearInterval(countInterval)
      clearInterval(heartbeatInterval)
    }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center space-x-2 text-gray-600">
        <UsersIcon className="w-5 h-5 animate-pulse" />
        <span className="text-sm">...</span>
      </div>
    )
  }

  return (
    <div className="flex items-center space-x-2 text-gray-600">
      <UsersIcon className="w-5 h-5" />
      <span className="text-sm">
        <span className="font-medium">{onlineCount}</span> online
      </span>
      <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
    </div>
  )
}