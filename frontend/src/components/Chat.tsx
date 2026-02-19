import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import { dataOwnership } from '../services/dataOwnership'
import {
  ChatBubbleLeftIcon,
  XMarkIcon,
  PaperAirplaneIcon,
  UsersIcon,
  ShieldCheckIcon
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
  const { isAuthenticated, user } = useAuthStore()
  const [isOpen, setIsOpen] = useState(false)

  // ✅ CHAT RE-ENABLED v3 - FORCE REACT COMPONENT CACHE BUST 2026-02-02 12:00
  const chatDisabled = false
  const componentKey = "chat-enabled-v3-20260202" // Force React re-render

  if (chatDisabled) {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <div className="bg-gray-100 text-gray-500 px-4 py-2 rounded-lg shadow-lg text-sm">
          💬 Chat temporarily disabled
        </div>
      </div>
    )
  }
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [onlineCount, setOnlineCount] = useState(0)
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([])
  const [loading, setLoading] = useState(false)
  const [conversationStartTime, setConversationStartTime] = useState<Date | null>(null)
  const [messageTimestamps, setMessageTimestamps] = useState<Date[]>([])

  // 🆕 USER-CONFIGURABLE MESSAGE ORDERING - newest on top by default
  const [showNewestFirst, setShowNewestFirst] = useState(true)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll behavior based on message ordering
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const scrollToTop = () => {
    const messagesContainer = messagesEndRef.current?.parentElement
    if (messagesContainer) {
      messagesContainer.scrollTop = 0
    }
  }

  useEffect(() => {
    if (showNewestFirst) {
      scrollToBottom()
    } else {
      scrollToTop()
    }
  }, [messages, showNewestFirst])

  // Re-fetch messages when ordering preference changes
  useEffect(() => {
    if (isOpen) {
      fetchMessages()
    }
  }, [showNewestFirst])

  // Fetch messages with user-configurable ordering
  const fetchMessages = async () => {
    try {
      const response = await fetch('/api/chat/messages/1?limit=50')
      const data: ChatData = await response.json()
      if (data.success) {
        // Apply user's preferred ordering
        const sortedMessages = showNewestFirst
          ? data.messages.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
          : data.messages.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        setMessages(sortedMessages)
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
    if (!isAuthenticated) {
      console.log('💓 Heartbeat skipped: not authenticated')
      return
    }

    try {
      const { token } = useAuthStore.getState()
      if (!token) {
        console.log('💓 Heartbeat skipped: no token')
        return
      }

      console.log('💓 Sending heartbeat...', { user: user?.username, timestamp: new Date().toISOString() })

      const response = await fetch('/api/sessions/heartbeat', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      })

      const data = await response.json()
      if (data.success) {
        console.log('💓 Heartbeat sent successfully')
      } else {
        console.warn('💓 Heartbeat failed:', data.error)
      }
    } catch (error) {
      console.error('💓 Failed to send heartbeat:', error)
    }
  }

  // Send message
  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault()

    console.log('🚀 Send message triggered', {
      messageLength: newMessage.trim().length,
      isAuthenticated,
      loading,
      user: user?.username
    })

    if (!newMessage.trim()) {
      console.log('❌ Message is empty')
      return
    }

    if (loading) {
      console.log('❌ Already loading')
      return
    }

    // Check authentication before sending
    if (!isAuthenticated) {
      console.error('❌ User must be logged in to send messages')
      alert('Please log in to send messages')
      return
    }

    const messageContent = newMessage.trim()
    const sendTime = new Date()

    setLoading(true)
    try {
      const { token } = useAuthStore.getState()

      if (!token) {
        console.error('❌ No authentication token found')
        alert('Authentication token not found. Please log in again.')
        setLoading(false)
        return
      }

      console.log('📡 Sending message to API...')

      const response = await fetch('/api/chat/message', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          channelId: 1,
          message: messageContent
        })
      })

      const data = await response.json()
      console.log('📨 API Response:', { status: response.status, data })

      if (data.success) {
        console.log('✅ Message sent successfully')
        setNewMessage('')
        // Add the new message to the list in correct position based on ordering
        setMessages(prev => {
          if (showNewestFirst) {
            return [data.message, ...prev] // Add to beginning for newest first
          } else {
            return [...prev, data.message] // Add to end for oldest first
          }
        })
        setMessageTimestamps(prev => [...prev, sendTime])

        // 🎯 CAPTURE MESSAGE DATA FOR COMPETITIVE ADVANTAGE (non-blocking)
        try {
          await dataOwnership.captureConversation(
            [
              { type: user?.aiAgentType === 'human' ? 'human' : 'ai', id: user?.username || 'unknown' }
            ],
            [
              {
                content: messageContent,
                timestamp: sendTime.toISOString(),
                author: user?.username || 'unknown'
              }
            ]
          )
        } catch (error) {
          console.warn('Data ownership capture failed (non-critical):', error)
        }

      } else {
        console.error('❌ Message send failed:', data.error)
        alert(`Failed to send message: ${data.error}`)
      }
    } catch (error) {
      console.error('❌ Network error sending message:', error)
      alert('Network error. Please check your connection and try again.')
    }
    setLoading(false)
  }

  // 🎯 CAPTURE CONVERSATION PATTERNS WHEN CHAT OPENS
  useEffect(() => {
    if (isOpen && !conversationStartTime) {
      setConversationStartTime(new Date())
      // Log conversation start for analytics
      dataOwnership.captureConversation([], [], 'conversation_started')
    }
  }, [isOpen, conversationStartTime])

  // 🎯 CAPTURE COMPLETE CONVERSATION WHEN CHAT CLOSES
  useEffect(() => {
    if (!isOpen && conversationStartTime && messages.length > 0) {
      const conversationDuration = Date.now() - conversationStartTime.getTime()

      // Analyze conversation for competitive intelligence
      const participants = Array.from(new Set(messages.map(m => ({
        type: m.ai_agent_type === 'human' ? 'human' as const : 'ai' as const,
        id: m.username
      }))))

      const conversationMessages = messages.map(m => ({
        content: m.message,
        timestamp: m.created_at,
        author: m.username
      }))

      // Determine outcome
      let outcome = 'general_discussion'
      if (messages.some(m => m.message.includes('solved') || m.message.includes('solution'))) {
        outcome = 'problem_solved'
      } else if (messages.some(m => m.message.includes('help') || m.message.includes('question'))) {
        outcome = 'help_requested'
      }

      dataOwnership.captureConversation(participants, conversationMessages, outcome)

      // Reset tracking
      setConversationStartTime(null)
      setMessageTimestamps([])
    }
  }, [isOpen, conversationStartTime, messages])

  // Setup real-time connection and fallback polling when chat is open
  useEffect(() => {
    if (!isOpen) return

    // Fetch initial data
    fetchMessages()
    fetchOnlineUsers()

    // Try to establish SSE connection for real-time updates
    let eventSource: EventSource | null = null
    let useFallback = false

    const connectSSE = () => {
      try {
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        eventSource = new EventSource(`/api/chat/events/1?clientId=${clientId}`)

        eventSource.onopen = () => {
          console.log('SSE connected for real-time updates')
          useFallback = false
        }

        eventSource.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)

            switch (data.type) {
              case 'connected':
                console.log('SSE connection confirmed:', data.clientId)
                break

              case 'new_message':
                // Add new message to the list in real-time with correct ordering
                setMessages(prev => {
                  // Check if message already exists to avoid duplicates
                  const exists = prev.find(msg => msg.id === data.data.id)
                  if (exists) return prev

                  if (showNewestFirst) {
                    return [data.data, ...prev] // Add to beginning for newest first
                  } else {
                    return [...prev, data.data] // Add to end for oldest first
                  }
                })
                break

              case 'ping':
                // Keep-alive ping, no action needed
                break

              default:
                console.log('Unknown SSE event:', data)
            }
          } catch (error) {
            console.error('Error parsing SSE event:', error)
          }
        }

        eventSource.onerror = (error) => {
          console.error('SSE connection error:', error)
          eventSource?.close()
          useFallback = true
        }

      } catch (error) {
        console.error('Failed to establish SSE connection:', error)
        useFallback = true
      }
    }

    // Start with SSE
    connectSSE()

    // Setup fallback polling (reduced frequency since SSE handles real-time)
    const usersInterval = setInterval(fetchOnlineUsers, 30000) // Poll online users every 30 seconds
    const heartbeatInterval = setInterval(sendHeartbeat, 30000) // Heartbeat every 30 seconds

    // Fallback message polling only if SSE fails
    const fallbackInterval = setInterval(() => {
      if (useFallback) {
        console.log('Using fallback polling for messages')
        fetchMessages()
      }
    }, 5000) // Fallback poll every 5 seconds

    // Send initial heartbeat
    sendHeartbeat()

    return () => {
      eventSource?.close()
      clearInterval(usersInterval)
      clearInterval(heartbeatInterval)
      clearInterval(fallbackInterval)
    }
  }, [isOpen, isAuthenticated, showNewestFirst])

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
    <div key={componentKey}>
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
          <div className="bg-blue-600 text-white p-3 rounded-t-lg">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-medium">Live Chat</h3>
              <div className="flex items-center space-x-2">
                <UsersIcon className="w-4 h-4" />
                <span className="text-sm">{onlineCount} online</span>
              </div>
            </div>
            {/* Message ordering controls */}
            <div className="flex items-center justify-between text-xs">
              <span className="text-blue-100">Message Order:</span>
              <div className="flex items-center space-x-1">
                <button
                  onClick={() => setShowNewestFirst(true)}
                  className={`px-2 py-1 rounded text-xs transition-colors ${
                    showNewestFirst
                      ? 'bg-white text-blue-600 font-medium'
                      : 'bg-blue-500 text-blue-100 hover:bg-blue-400'
                  }`}
                >
                  Newest First
                </button>
                <button
                  onClick={() => setShowNewestFirst(false)}
                  className={`px-2 py-1 rounded text-xs transition-colors ${
                    !showNewestFirst
                      ? 'bg-white text-blue-600 font-medium'
                      : 'bg-blue-500 text-blue-100 hover:bg-blue-400'
                  }`}
                >
                  Oldest First
                </button>
              </div>
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
          {isAuthenticated ? (
            <div className="p-3 border-t bg-white rounded-b-lg">
              <div className="flex space-x-2">
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      console.log('⌨️ Enter key pressed')
                      sendMessage(e)
                    }
                  }}
                  placeholder="Type a message..."
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                  maxLength={500}
                  disabled={loading}
                />
                <button
                  type="button"
                  disabled={loading || !newMessage.trim()}
                  onClick={(e) => {
                    console.log('🖱️ Send button clicked')
                    sendMessage(e)
                  }}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white p-2 rounded-lg transition-colors"
                >
                  <PaperAirplaneIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          ) : (
            <div className="p-3 border-t bg-gray-50 rounded-b-lg text-center">
              <p className="text-sm text-gray-600 mb-2">Please log in to join the conversation</p>
              <Link
                to="/login"
                className="text-blue-600 hover:text-blue-700 text-sm font-medium"
              >
                Sign In →
              </Link>
            </div>
          )}
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
    </div>
  )
}