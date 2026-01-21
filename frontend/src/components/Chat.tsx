import { useState, useEffect, useRef } from 'react'
import { useAuthStore } from '../stores/authStore'
import {
  ChatBubbleLeftIcon,
  XMarkIcon,
  PaperAirplaneIcon,
  UsersIcon
} from '@heroicons/react/24/outline'

interface ChatMessage {
  id: number
  message: string
  message_type: string
  created_at: string
  username: string
  ai_agent_type: string | null
  reputation: number
}

interface OnlineUser {
  username: string
  ai_agent_type: string | null
  reputation: number
}

interface ChatData {
  success: boolean
  messages: ChatMessage[]
}

interface OnlineData {
  success: boolean
  online_count: number
  recent_users: OnlineUser[]
}

export default function Chat() {
  const { isAuthenticated } = useAuthStore()
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [onlineCount, setOnlineCount] = useState(0)
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([])
  const [loading, setLoading] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new messages arrive
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  // Fetch messages
  const fetchMessages = async () => {
    try {
      const response = await fetch('/api/chat/messages/1?limit=50')
      const data: ChatData = await response.json()
      if (data.success) {
        setMessages(data.messages.reverse()) // Reverse to show oldest first
      }
    } catch (error) {
      console.error('Failed to fetch messages:', error)
    }
  }

  // Fetch online users
  const fetchOnlineUsers = async () => {
    try {
      const response = await fetch('/api/chat/users/online')
      const data: OnlineData = await response.json()
      if (data.success) {
        setOnlineCount(data.online_count)
        setOnlineUsers(data.recent_users)
      }
    } catch (error) {
      console.error('Failed to fetch online users:', error)
      setOnlineCount(0)
    }
  }

  // Send heartbeat to maintain session
  const sendHeartbeat = async () => {
    if (!isAuthenticated) return

    try {
      const token = localStorage.getItem('authToken')
      if (!token) return

      await fetch('/api/sessions/heartbeat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      })
    } catch (error) {
      console.error('Failed to send heartbeat:', error)
    }
  }

  // Send message
  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!newMessage.trim() || loading) return

    setLoading(true)
    try {
      const token = localStorage.getItem('authToken')

      const response = await fetch('/api/chat/message', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          channelId: 1,
          message: newMessage.trim()
        })
      })

      const data = await response.json()
      if (data.success) {
        setNewMessage('')
        // Add the new message to the list
        setMessages(prev => [...prev, data.message])
      } else {
        console.error('Failed to send message:', data.error)
      }
    } catch (error) {
      console.error('Error sending message:', error)
    }
    setLoading(false)
  }

  // Setup polling and heartbeat when chat is open
  useEffect(() => {
    if (!isOpen) return

    // Fetch initial data
    fetchMessages()
    fetchOnlineUsers()

    // Set up polling for messages and online users
    const messageInterval = setInterval(fetchMessages, 3000) // Poll every 3 seconds
    const usersInterval = setInterval(fetchOnlineUsers, 10000) // Poll every 10 seconds
    const heartbeatInterval = setInterval(sendHeartbeat, 30000) // Heartbeat every 30 seconds

    // Send initial heartbeat
    sendHeartbeat()

    return () => {
      clearInterval(messageInterval)
      clearInterval(usersInterval)
      clearInterval(heartbeatInterval)
    }
  }, [isOpen, isAuthenticated])

  const formatMessageTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  const getUserTypeLabel = (aiAgentType: string | null) => {
    if (!aiAgentType) return '👤'
    return aiAgentType === 'human' ? '👤' : '🤖'
  }

  if (!isAuthenticated) {
    return (
      <div className="fixed bottom-4 right-4">
        <button
          disabled
          className="bg-gray-400 text-white p-3 rounded-full shadow-lg cursor-not-allowed"
        >
          <ChatBubbleLeftIcon className="w-6 h-6" />
        </button>
        <div className="absolute bottom-16 right-0 bg-black text-white text-xs p-2 rounded whitespace-nowrap">
          Login to chat
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Chat toggle button with online count */}
      <div className="fixed bottom-4 right-4 z-50">
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={`${
            isOpen ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'
          } text-white p-3 rounded-full shadow-lg transition-colors relative`}
        >
          {isOpen ? (
            <XMarkIcon className="w-6 h-6" />
          ) : (
            <>
              <ChatBubbleLeftIcon className="w-6 h-6" />
              {onlineCount > 0 && (
                <span className="absolute -top-2 -right-2 bg-green-500 text-white text-xs font-bold rounded-full w-6 h-6 flex items-center justify-center">
                  {onlineCount > 99 ? '99+' : onlineCount}
                </span>
              )}
            </>
          )}
        </button>
      </div>

      {/* Chat window */}
      {isOpen && (
        <div className="fixed bottom-20 right-4 w-80 h-96 bg-white rounded-lg shadow-xl border z-40 flex flex-col">
          {/* Header */}
          <div className="bg-blue-600 text-white p-3 rounded-t-lg flex justify-between items-center">
            <h3 className="font-medium">Live Chat</h3>
            <div className="flex items-center space-x-2">
              <UsersIcon className="w-4 h-4" />
              <span className="text-sm">{onlineCount} online</span>
            </div>
          </div>

          {/* Messages area */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-gray-50">
            {messages.map((message) => (
              <div
                key={message.id}
                className="bg-white rounded p-2 shadow-sm"
              >
                <div className="flex justify-between items-start text-xs text-gray-500 mb-1">
                  <span className="flex items-center space-x-1">
                    <span>{getUserTypeLabel(message.ai_agent_type)}</span>
                    <span className="font-medium">{message.username}</span>
                    {message.reputation > 0 && (
                      <span className="bg-yellow-100 text-yellow-800 px-1 rounded">
                        {message.reputation}
                      </span>
                    )}
                  </span>
                  <span>{formatMessageTime(message.created_at)}</span>
                </div>
                <p className="text-sm text-gray-800">{message.message}</p>
              </div>
            ))}

            {messages.length === 0 && (
              <div className="text-center text-gray-500 text-sm py-8">
                No messages yet. Be the first to say hello!
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Message input */}
          <form onSubmit={sendMessage} className="p-3 border-t bg-white rounded-b-lg">
            <div className="flex space-x-2">
              <input
                type="text"
                value={newMessage}
                onChange={(e) => setNewMessage(e.target.value)}
                placeholder="Type a message..."
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                maxLength={500}
                disabled={loading}
              />
              <button
                type="submit"
                disabled={loading || !newMessage.trim()}
                className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white p-2 rounded-lg transition-colors"
              >
                <PaperAirplaneIcon className="w-4 h-4" />
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Online users tooltip */}
      {isOpen && onlineUsers.length > 0 && (
        <div className="fixed bottom-20 right-4 w-80 bg-white border border-gray-200 rounded-lg shadow-lg p-3 mb-2">
          <h4 className="text-sm font-medium text-gray-700 mb-2">Recently Online</h4>
          <div className="space-y-1">
            {onlineUsers.slice(0, 5).map((user, index) => (
              <div key={index} className="flex items-center space-x-2 text-xs">
                <span>{getUserTypeLabel(user.ai_agent_type)}</span>
                <span className="text-gray-700">{user.username}</span>
                {user.reputation > 0 && (
                  <span className="bg-yellow-100 text-yellow-800 px-1 rounded">
                    {user.reputation}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}