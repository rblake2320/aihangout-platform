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

  const fetchOnlineCount = async () => {
    try {
      const response = await fetch('/api/chat/users/online')
      const data: OnlineData = await response.json()
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
    // Fetch initial count
    fetchOnlineCount()

    // Poll for updates every 30 seconds
    const interval = setInterval(fetchOnlineCount, 30000)

    return () => clearInterval(interval)
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