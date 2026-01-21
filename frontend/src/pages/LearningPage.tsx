import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  DocumentTextIcon,
  ClipboardDocumentListIcon,
  BeakerIcon,
  CpuChipIcon,
  BookOpenIcon,
  RocketLaunchIcon,
  EyeIcon,
  ChevronDownIcon,
  StarIcon
} from '@heroicons/react/24/outline'

interface LearningContent {
  id: number
  title: string
  content_type: string
  summary: string
  author_company: string
  author_name: string
  version: string
  tags: string[]
  category: string
  difficulty: string
  is_featured: boolean
  is_nvidia_content: boolean
  upvotes: number
  views: number
  created_at: string
}

const CONTENT_TYPE_ICONS = {
  blueprint: ClipboardDocumentListIcon,
  paper: DocumentTextIcon,
  research: BeakerIcon,
  model_card: CpuChipIcon,
  documentation: BookOpenIcon,
  launchable: RocketLaunchIcon,
  overview: EyeIcon,
  notes: DocumentTextIcon
}

const CONTENT_TYPE_COLORS = {
  blueprint: 'bg-blue-100 text-blue-800',
  paper: 'bg-green-100 text-green-800',
  research: 'bg-purple-100 text-purple-800',
  model_card: 'bg-orange-100 text-orange-800',
  documentation: 'bg-gray-100 text-gray-800',
  launchable: 'bg-red-100 text-red-800',
  overview: 'bg-indigo-100 text-indigo-800',
  notes: 'bg-yellow-100 text-yellow-800'
}

export default function LearningPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [content, setContent] = useState<LearningContent[]>([])
  const [featured, setFeatured] = useState<LearningContent[]>([])
  const [categories, setCategories] = useState<any[]>([])
  const [contentTypes, setContentTypes] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedType, setSelectedType] = useState(searchParams.get('type') || 'all')
  const [selectedCategory, setSelectedCategory] = useState(searchParams.get('category') || 'all')
  const [showFilters, setShowFilters] = useState(false)

  useEffect(() => {
    fetchContent()
    fetchFeatured()
    fetchCategories()
  }, [selectedType, selectedCategory])

  const fetchContent = async () => {
    try {
      const params = new URLSearchParams()
      if (selectedType !== 'all') params.set('type', selectedType)
      if (selectedCategory !== 'all') params.set('category', selectedCategory)

      const response = await fetch(`/api/learning?${params.toString()}`)
      const data = await response.json()

      if (data.success) {
        setContent(data.content)
      }
    } catch (error) {
      console.error('Failed to fetch learning content:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchFeatured = async () => {
    try {
      const response = await fetch('/api/learning/featured')
      const data = await response.json()

      if (data.success) {
        setFeatured(data.featured)
      }
    } catch (error) {
      console.error('Failed to fetch featured content:', error)
    }
  }

  const fetchCategories = async () => {
    try {
      const response = await fetch('/api/learning/categories')
      const data = await response.json()

      if (data.success) {
        setCategories(data.categories)
        setContentTypes(data.contentTypes)
      }
    } catch (error) {
      console.error('Failed to fetch categories:', error)
    }
  }

  const handleTypeChange = (type: string) => {
    setSelectedType(type)
    const params = new URLSearchParams(searchParams)
    if (type === 'all') {
      params.delete('type')
    } else {
      params.set('type', type)
    }
    setSearchParams(params)
  }

  const handleCategoryChange = (category: string) => {
    setSelectedCategory(category)
    const params = new URLSearchParams(searchParams)
    if (category === 'all') {
      params.delete('category')
    } else {
      params.set('category', category)
    }
    setSearchParams(params)
  }

  const ContentCard = ({ item }: { item: LearningContent }) => {
    const IconComponent = CONTENT_TYPE_ICONS[item.content_type as keyof typeof CONTENT_TYPE_ICONS] || DocumentTextIcon
    const colorClass = CONTENT_TYPE_COLORS[item.content_type as keyof typeof CONTENT_TYPE_COLORS] || 'bg-gray-100 text-gray-800'

    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center space-x-3">
            <div className={`p-2 rounded-lg ${colorClass}`}>
              <IconComponent className="w-5 h-5" />
            </div>
            <div>
              <span className={`px-2 py-1 text-xs font-medium rounded-full ${colorClass}`}>
                {item.content_type.replace('_', ' ').toUpperCase()}
              </span>
              {item.is_featured && (
                <StarIcon className="w-4 h-4 text-yellow-400 fill-yellow-400 inline ml-2" />
              )}
            </div>
          </div>
          {item.is_nvidia_content && (
            <span className="px-2 py-1 text-xs font-medium bg-green-100 text-green-800 rounded-full">
              NVIDIA
            </span>
          )}
        </div>

        <h3 className="text-lg font-semibold text-gray-900 mb-2 line-clamp-2">
          {item.title}
        </h3>

        {item.summary && (
          <p className="text-gray-600 text-sm mb-4 line-clamp-3">
            {item.summary}
          </p>
        )}

        <div className="flex items-center justify-between text-sm text-gray-500 mb-4">
          <div>
            {item.author_company && (
              <span className="font-medium">{item.author_company}</span>
            )}
            {item.author_name && item.author_company && <span> • </span>}
            {item.author_name && <span>{item.author_name}</span>}
          </div>
          {item.version && (
            <span className="px-2 py-1 bg-gray-100 text-gray-800 rounded text-xs">
              v{item.version}
            </span>
          )}
        </div>

        {item.tags && item.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-4">
            {item.tags.slice(0, 3).map((tag, index) => (
              <span
                key={index}
                className="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded"
              >
                {tag}
              </span>
            ))}
            {item.tags.length > 3 && (
              <span className="px-2 py-1 text-xs bg-gray-50 text-gray-500 rounded">
                +{item.tags.length - 3}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between text-sm text-gray-500">
          <div className="flex items-center space-x-4">
            <span>{item.views} views</span>
            <span>{item.upvotes} upvotes</span>
            {item.difficulty && (
              <span className={`px-2 py-1 rounded text-xs ${
                item.difficulty === 'beginner' ? 'bg-green-100 text-green-800' :
                item.difficulty === 'intermediate' ? 'bg-yellow-100 text-yellow-800' :
                'bg-red-100 text-red-800'
              }`}>
                {item.difficulty}
              </span>
            )}
          </div>
          <span>{new Date(item.created_at).toLocaleDateString()}</span>
        </div>

        <div className="mt-4 pt-4 border-t border-gray-100">
          <button className="text-blue-600 hover:text-blue-700 text-sm font-medium">
            View Content →
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-4">
              AI Learning Hub
            </h1>
            <p className="text-lg text-gray-600">
              Blueprints, research papers, model cards, and technical documentation for AI development
            </p>
          </div>
          <div className="text-right">
            <button className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
              Contribute Content
            </button>
          </div>
        </div>
      </div>

      {/* Featured Content */}
      {featured.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
            <StarIcon className="w-5 h-5 text-yellow-400 mr-2" />
            Featured Content
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {featured.slice(0, 3).map((item) => (
              <ContentCard key={item.id} item={item} />
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-medium text-gray-900">Filter Content</h3>
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center text-sm text-gray-500"
          >
            <ChevronDownIcon className={`w-4 h-4 ml-1 transition-transform ${showFilters ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {showFilters && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Content Type
              </label>
              <select
                value={selectedType}
                onChange={(e) => handleTypeChange(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Types</option>
                {contentTypes.map((type) => (
                  <option key={type.content_type} value={type.content_type}>
                    {type.content_type.replace('_', ' ').toUpperCase()} ({type.count})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Category
              </label>
              <select
                value={selectedCategory}
                onChange={(e) => handleCategoryChange(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="all">All Categories</option>
                {categories.map((cat) => (
                  <option key={cat.category} value={cat.category}>
                    {cat.category} ({cat.count})
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Content Grid */}
      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="text-gray-500 mt-4">Loading learning content...</p>
        </div>
      ) : content.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {content.map((item) => (
            <ContentCard key={item.id} item={item} />
          ))}
        </div>
      ) : (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <BookOpenIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Content Found</h3>
          <p className="text-gray-500 mb-4">
            No learning content matches your current filters.
          </p>
          <button
            onClick={() => {
              setSelectedType('all')
              setSelectedCategory('all')
              setSearchParams({})
            }}
            className="text-blue-600 hover:text-blue-700 font-medium"
          >
            Clear Filters
          </button>
        </div>
      )}

      {/* Quick Stats */}
      <div className="mt-12 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{content.length}</div>
          <div className="text-sm text-gray-500">Total Content</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{contentTypes.length}</div>
          <div className="text-sm text-gray-500">Content Types</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{categories.length}</div>
          <div className="text-sm text-gray-500">Categories</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{featured.length}</div>
          <div className="text-sm text-gray-500">Featured</div>
        </div>
      </div>
    </div>
  )
}