import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import {
  DocumentTextIcon,
  ClipboardDocumentListIcon,
  BeakerIcon,
  CpuChipIcon,
  BookOpenIcon,
  RocketLaunchIcon,
  EyeIcon,
  ArrowLeftIcon,
  ArrowTopRightOnSquareIcon,
  ArrowDownTrayIcon,
  HandThumbUpIcon,
  StarIcon
} from '@heroicons/react/24/outline'

interface LearningContent {
  id: number
  title: string
  content_type: string
  content: string
  summary: string
  author_company: string
  author_name: string
  version: string
  tags: string[]
  category: string
  difficulty: string
  is_featured: boolean
  is_nvidia_content: boolean
  external_url: string
  download_url: string
  upvotes: number
  views: number
  created_at: string
  attachments: { id: number; file_name: string; file_url: string; file_type: string }[]
}

const CONTENT_TYPE_ICONS: Record<string, typeof DocumentTextIcon> = {
  blueprint: ClipboardDocumentListIcon,
  paper: DocumentTextIcon,
  research: BeakerIcon,
  model_card: CpuChipIcon,
  documentation: BookOpenIcon,
  launchable: RocketLaunchIcon,
  overview: EyeIcon,
  notes: DocumentTextIcon
}

const CONTENT_TYPE_COLORS: Record<string, string> = {
  blueprint: 'bg-blue-100 text-blue-800',
  paper: 'bg-green-100 text-green-800',
  research: 'bg-purple-100 text-purple-800',
  model_card: 'bg-orange-100 text-orange-800',
  documentation: 'bg-gray-100 text-gray-800',
  launchable: 'bg-red-100 text-red-800',
  overview: 'bg-indigo-100 text-indigo-800',
  notes: 'bg-yellow-100 text-yellow-800'
}

export default function LearningDetailPage() {
  const { id } = useParams<{ id: string }>()
  const [content, setContent] = useState<LearningContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchContent()
  }, [id])

  const fetchContent = async () => {
    try {
      const response = await fetch(`/api/learning/${id}`)
      const data = await response.json()

      if (data.success) {
        setContent(data.content)
      } else {
        setError(data.error || 'Content not found')
      }
    } catch (err) {
      console.error('Failed to fetch learning content:', err)
      setError('Failed to load content')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto text-center py-12">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
        <p className="text-gray-500 mt-4">Loading content...</p>
      </div>
    )
  }

  if (error || !content) {
    return (
      <div className="max-w-4xl mx-auto text-center py-12">
        <BookOpenIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-gray-900 mb-2">Content Not Found</h2>
        <p className="text-gray-500 mb-4">{error || 'The requested content could not be found.'}</p>
        <Link to="/learning" className="text-blue-600 hover:text-blue-700 font-medium">
          Back to Learning Hub
        </Link>
      </div>
    )
  }

  const IconComponent = CONTENT_TYPE_ICONS[content.content_type] || DocumentTextIcon
  const colorClass = CONTENT_TYPE_COLORS[content.content_type] || 'bg-gray-100 text-gray-800'

  return (
    <div className="max-w-4xl mx-auto">
      <Link to="/learning" className="inline-flex items-center text-blue-600 hover:text-blue-700 mb-6">
        <ArrowLeftIcon className="w-4 h-4 mr-1" />
        Back to Learning Hub
      </Link>

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
        <div className="flex items-start justify-between mb-6">
          <div className="flex items-center space-x-3">
            <div className={`p-3 rounded-lg ${colorClass}`}>
              <IconComponent className="w-6 h-6" />
            </div>
            <div>
              <span className={`px-3 py-1 text-sm font-medium rounded-full ${colorClass}`}>
                {content.content_type.replace('_', ' ').toUpperCase()}
              </span>
              {content.is_featured && (
                <StarIcon className="w-5 h-5 text-yellow-400 fill-yellow-400 inline ml-2" />
              )}
              {content.is_nvidia_content && (
                <span className="ml-2 px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded-full">
                  NVIDIA
                </span>
              )}
            </div>
          </div>
          {content.version && (
            <span className="px-3 py-1 bg-gray-100 text-gray-700 rounded text-sm">
              v{content.version}
            </span>
          )}
        </div>

        <h1 className="text-2xl font-bold text-gray-900 mb-4">{content.title}</h1>

        {content.summary && (
          <p className="text-gray-600 text-lg mb-6 leading-relaxed">{content.summary}</p>
        )}

        <div className="flex items-center justify-between text-sm text-gray-500 mb-6 pb-6 border-b border-gray-200">
          <div className="flex items-center space-x-4">
            {content.author_company && (
              <span className="font-medium text-gray-700">{content.author_company}</span>
            )}
            {content.author_name && (
              <span>{content.author_name}</span>
            )}
          </div>
          <div className="flex items-center space-x-4">
            <span className="flex items-center">
              <EyeIcon className="w-4 h-4 mr-1" />
              {content.views} views
            </span>
            <span className="flex items-center">
              <HandThumbUpIcon className="w-4 h-4 mr-1" />
              {content.upvotes} upvotes
            </span>
            {content.difficulty && (
              <span className={`px-2 py-1 rounded text-xs ${
                content.difficulty === 'beginner' ? 'bg-green-100 text-green-800' :
                content.difficulty === 'intermediate' ? 'bg-yellow-100 text-yellow-800' :
                'bg-red-100 text-red-800'
              }`}>
                {content.difficulty}
              </span>
            )}
          </div>
        </div>

        {content.tags && content.tags.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-6">
            {content.tags.map((tag, index) => (
              <span
                key={index}
                className="px-3 py-1 text-sm bg-blue-50 text-blue-700 rounded-full"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {content.content && (
          <div className="prose max-w-none mb-8">
            <div className="bg-gray-50 rounded-lg p-6 whitespace-pre-wrap text-gray-800 leading-relaxed">
              {content.content}
            </div>
          </div>
        )}

        <div className="flex items-center space-x-4 pt-6 border-t border-gray-200">
          {content.external_url && (
            <a
              href={content.external_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <ArrowTopRightOnSquareIcon className="w-4 h-4 mr-2" />
              View Original
            </a>
          )}
          {content.download_url && (
            <a
              href={content.download_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors"
            >
              <ArrowDownTrayIcon className="w-4 h-4 mr-2" />
              Download
            </a>
          )}
          <span className="text-sm text-gray-500">
            Added {new Date(content.created_at).toLocaleDateString()}
          </span>
        </div>

        {content.attachments && content.attachments.length > 0 && (
          <div className="mt-6 pt-6 border-t border-gray-200">
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Attachments</h3>
            <div className="space-y-2">
              {content.attachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={attachment.file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center p-3 bg-gray-50 rounded-lg hover:bg-gray-100 transition-colors"
                >
                  <DocumentTextIcon className="w-5 h-5 text-gray-400 mr-3" />
                  <span className="text-blue-600">{attachment.file_name}</span>
                  <span className="ml-2 text-xs text-gray-400">{attachment.file_type}</span>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
