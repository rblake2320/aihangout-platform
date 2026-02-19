import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeftIcon, RocketLaunchIcon, CheckCircleIcon } from '@heroicons/react/24/outline'

interface PlatformVersion {
  id: number
  version: string
  title: string
  description: string
  release_type: string
  features: string[]
  created_at: string
}

const RELEASE_COLORS: Record<string, string> = {
  major: 'bg-blue-100 text-blue-800',
  minor: 'bg-green-100 text-green-800',
  patch: 'bg-gray-100 text-gray-800'
}

export default function ChangelogPage() {
  const [versions, setVersions] = useState<PlatformVersion[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/versions')
      .then(r => r.json())
      .then(data => {
        if (data.success) setVersions(data.versions)
      })
      .catch(err => console.error('Failed to fetch versions:', err))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto text-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        <p className="text-gray-500 mt-4">Loading changelog...</p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto">
      <Link to="/" className="inline-flex items-center text-blue-600 hover:text-blue-700 mb-6">
        <ArrowLeftIcon className="w-4 h-4 mr-1" />
        Back to Home
      </Link>

      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2 flex items-center">
          <RocketLaunchIcon className="w-8 h-8 mr-3 text-blue-600" />
          Changelog
        </h1>
        <p className="text-lg text-gray-600">
          Platform updates, new features, and improvements.
        </p>
      </div>

      {versions.length === 0 ? (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <p className="text-gray-500">No version history available yet.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {versions.map((version, index) => (
            <div
              key={version.id}
              className={`bg-white rounded-lg shadow-sm border border-gray-200 p-6 ${
                index === 0 ? 'ring-2 ring-blue-200' : ''
              }`}
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-3">
                  <span className="text-xl font-bold text-gray-900">v{version.version}</span>
                  <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                    RELEASE_COLORS[version.release_type] || RELEASE_COLORS.patch
                  }`}>
                    {version.release_type}
                  </span>
                  {index === 0 && (
                    <span className="px-2 py-1 text-xs font-medium bg-blue-600 text-white rounded-full">
                      Latest
                    </span>
                  )}
                </div>
                <span className="text-sm text-gray-500">
                  {new Date(version.created_at).toLocaleDateString()}
                </span>
              </div>

              <h3 className="text-lg font-semibold text-gray-900 mb-2">{version.title}</h3>

              {version.description && (
                <p className="text-gray-600 mb-4">{version.description}</p>
              )}

              {version.features && version.features.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-gray-700 mb-2">Features:</h4>
                  <ul className="space-y-1">
                    {version.features.map((feature, i) => (
                      <li key={i} className="flex items-start space-x-2 text-sm text-gray-600">
                        <CheckCircleIcon className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
