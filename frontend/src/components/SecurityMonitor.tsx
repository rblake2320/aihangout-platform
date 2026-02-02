import { useState, useEffect } from 'react'
import {
  ShieldCheckIcon,
  ExclamationTriangleIcon,
  XCircleIcon,
  CheckCircleIcon,
  EyeIcon
} from '@heroicons/react/24/outline'

interface SecurityStats {
  totalChecks: number
  blocked: number
  flagged: number
  approved: number
  uptime: string
  lastUpdate: string
}

interface SecurityAlert {
  id: number
  type: 'prompt_injection' | 'malicious_code' | 'harmful_content' | 'spam'
  content: string
  userId: number
  userType: 'human' | 'ai'
  timestamp: string
  action: 'blocked' | 'flagged' | 'approved'
}

export default function SecurityMonitor() {
  const [stats, setStats] = useState<SecurityStats>({
    totalChecks: 0,
    blocked: 0,
    flagged: 0,
    approved: 0,
    uptime: '99.9%',
    lastUpdate: new Date().toISOString()
  })
  const [alerts, setAlerts] = useState<SecurityAlert[]>([])
  const [showDetails, setShowDetails] = useState(false)

  useEffect(() => {
    fetchSecurityStats()
    fetchRecentAlerts()

    // Update stats every 30 seconds
    const interval = setInterval(() => {
      fetchSecurityStats()
    }, 30000)

    return () => clearInterval(interval)
  }, [])

  const fetchSecurityStats = async () => {
    try {
      const response = await fetch('/api/security/stats')
      const data = await response.json()
      if (data.success) {
        setStats(data.stats)
      }
    } catch (error) {
      console.error('Failed to fetch security stats:', error)
    }
  }

  const fetchRecentAlerts = async () => {
    try {
      const response = await fetch('/api/security/alerts?limit=10')
      const data = await response.json()
      if (data.success) {
        setAlerts(data.alerts)
      }
    } catch (error) {
      console.error('Failed to fetch security alerts:', error)
    }
  }

  const getAlertIcon = (type: SecurityAlert['type']) => {
    switch (type) {
      case 'prompt_injection':
        return <ExclamationTriangleIcon className="w-4 h-4 text-red-600" />
      case 'malicious_code':
        return <XCircleIcon className="w-4 h-4 text-red-600" />
      case 'harmful_content':
        return <ExclamationTriangleIcon className="w-4 h-4 text-orange-600" />
      case 'spam':
        return <EyeIcon className="w-4 h-4 text-yellow-600" />
    }
  }

  const getActionColor = (action: SecurityAlert['action']) => {
    switch (action) {
      case 'blocked':
        return 'bg-red-100 text-red-800'
      case 'flagged':
        return 'bg-yellow-100 text-yellow-800'
      case 'approved':
        return 'bg-green-100 text-green-800'
    }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center space-x-2">
          <ShieldCheckIcon className="w-5 h-5 text-green-600" />
          <h3 className="text-sm font-medium text-gray-900">Security Monitor</h3>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800">
            Active
          </span>
        </div>
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          {showDetails ? 'Hide' : 'Show'} Details
        </button>
      </div>

      {/* Quick Stats */}
      <div className="px-4 py-3">
        <div className="grid grid-cols-4 gap-4 text-center">
          <div>
            <div className="text-lg font-semibold text-green-600">{stats.approved}</div>
            <div className="text-xs text-gray-500">Approved</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-yellow-600">{stats.flagged}</div>
            <div className="text-xs text-gray-500">Flagged</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-red-600">{stats.blocked}</div>
            <div className="text-xs text-gray-500">Blocked</div>
          </div>
          <div>
            <div className="text-lg font-semibold text-blue-600">{stats.uptime}</div>
            <div className="text-xs text-gray-500">Uptime</div>
          </div>
        </div>
      </div>

      {/* Detailed View */}
      {showDetails && (
        <div className="border-t border-gray-200">
          <div className="px-4 py-3 bg-gray-50">
            <h4 className="text-sm font-medium text-gray-900 mb-3">Recent Security Events</h4>

            {alerts.length > 0 ? (
              <div className="space-y-2">
                {alerts.slice(0, 5).map((alert) => (
                  <div key={alert.id} className="flex items-center justify-between text-xs bg-white rounded p-2">
                    <div className="flex items-center space-x-2">
                      {getAlertIcon(alert.type)}
                      <span className="font-medium">{alert.type.replace('_', ' ')}</span>
                      <span className="text-gray-500">from {alert.userType}</span>
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${getActionColor(alert.action)}`}>
                        {alert.action}
                      </span>
                      <span className="text-gray-500">
                        {new Date(alert.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-center py-4">
                <CheckCircleIcon className="w-8 h-8 text-green-600 mx-auto mb-2" />
                <p className="text-sm text-gray-500">All clear! No security incidents detected.</p>
              </div>
            )}
          </div>

          {/* Security Features */}
          <div className="px-4 py-3 border-t border-gray-200">
            <h4 className="text-sm font-medium text-gray-900 mb-3">Active Protections</h4>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center space-x-2">
                <CheckCircleIcon className="w-4 h-4 text-green-600" />
                <span>Prompt Injection Detection</span>
              </div>
              <div className="flex items-center space-x-2">
                <CheckCircleIcon className="w-4 h-4 text-green-600" />
                <span>Malicious Code Filtering</span>
              </div>
              <div className="flex items-center space-x-2">
                <CheckCircleIcon className="w-4 h-4 text-green-600" />
                <span>Content Moderation</span>
              </div>
              <div className="flex items-center space-x-2">
                <CheckCircleIcon className="w-4 h-4 text-green-600" />
                <span>AI Response Validation</span>
              </div>
              <div className="flex items-center space-x-2">
                <CheckCircleIcon className="w-4 h-4 text-green-600" />
                <span>Spam Detection</span>
              </div>
              <div className="flex items-center space-x-2">
                <CheckCircleIcon className="w-4 h-4 text-green-600" />
                <span>Enterprise Audit Trail</span>
              </div>
            </div>
          </div>

          {/* Last Updated */}
          <div className="px-4 py-2 bg-gray-50 border-t border-gray-200">
            <div className="text-xs text-gray-500 text-center">
              Last updated: {new Date(stats.lastUpdate).toLocaleString()}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}