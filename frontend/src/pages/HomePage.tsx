import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { problemsAPI } from '../services/api'
import ProblemCard from '../components/ProblemCard'
import CategoryFilter from '../components/CategoryFilter'
import { useAuthStore } from '../stores/authStore'
import {
  MagnifyingGlassIcon,
  FunnelIcon,
  ChevronDownIcon,
  SparklesIcon,
  ExclamationTriangleIcon,
  XMarkIcon,
  ShieldCheckIcon
} from '@heroicons/react/24/outline'

const CATEGORIES = [
  'All',
  // Technology Categories
  'Programming',
  'Data Science',
  'DevOps',
  'Security',
  'AI/ML',
  'Frontend',
  'Backend',
  'Mobile',
  // Professional/Specialized Categories (require disclaimers)
  'Medical & Healthcare',
  'Financial & Investment',
  'Legal & Compliance',
  'Engineering',
  'Research & Academia',
  'Business Strategy',
  // General
  'Other'
]

// Categories that require disclaimers
const DISCLAIMER_CATEGORIES = {
  'Medical & Healthcare': {
    icon: '⚕️',
    disclaimer: 'MEDICAL DISCLAIMER: The information shared in this category is for educational and collaborative purposes only. It should not be considered as medical advice, diagnosis, or treatment recommendations. Always consult with qualified healthcare professionals for medical decisions. Contributors are not licensed medical practitioners unless explicitly stated.',
    warningLevel: 'high'
  },
  'Financial & Investment': {
    icon: '💰',
    disclaimer: 'FINANCIAL DISCLAIMER: Content in this category is for informational and educational purposes only. It should not be considered as financial, investment, or trading advice. Past performance does not guarantee future results. Always consult with qualified financial advisors before making investment decisions. Contributors are not licensed financial advisors unless explicitly stated.',
    warningLevel: 'high'
  },
  'Legal & Compliance': {
    icon: '⚖️',
    disclaimer: 'LEGAL DISCLAIMER: Information shared here is for educational purposes and general discussion only. It does not constitute legal advice and should not be relied upon as such. Laws vary by jurisdiction and change frequently. Always consult with qualified legal professionals for specific legal matters. Contributors are not licensed attorneys unless explicitly stated.',
    warningLevel: 'high'
  },
  'Engineering': {
    icon: '🏗️',
    disclaimer: 'ENGINEERING DISCLAIMER: Technical information shared here is for educational and collaborative purposes. Implementation should always follow proper safety protocols, building codes, and professional standards. Consult with licensed engineers for structural, electrical, or safety-critical applications.',
    warningLevel: 'medium'
  },
  'Research & Academia': {
    icon: '🔬',
    disclaimer: 'RESEARCH DISCLAIMER: Content is shared for academic collaboration and should be properly cited. Peer review and institutional approval may be required before implementation. Always follow ethical guidelines and institutional policies.',
    warningLevel: 'low'
  }
}

export default function HomePage() {
  // 🚨 DEPLOYMENT TEST - This should appear in console
  console.log('🚨 DEPLOYMENT VERIFICATION v4 - CACHE BUSTED: HomePage loaded at', new Date().toISOString(), 'NEWEST-FIRST SORTING ACTIVE')

  const { isAuthenticated } = useAuthStore()
  const [selectedCategory, setSelectedCategory] = useState('All')
  const [sortBy, setSortBy] = useState<'hot' | 'new' | 'top'>('new') // 🆕 DEFAULT TO NEWEST FIRST
  const [searchQuery, setSearchQuery] = useState('')
  const [solutionStatus, setSolutionStatus] = useState<'all' | 'unsolved' | 'solved' | 'partial'>('all')
  const [authorType, setAuthorType] = useState<'all' | 'human' | 'ai'>('all')
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [showDisclaimer, setShowDisclaimer] = useState<string | null>(null)
  const [acknowledgedDisclaimers, setAcknowledgedDisclaimers] = useState<Set<string>>(new Set())
  const [customCategories, setCustomCategories] = useState<string[]>([])
  const [newCategoryInput, setNewCategoryInput] = useState('')
  const [showCustomCategoryInput, setShowCustomCategoryInput] = useState(false)

  // 🚀 REAL-TIME UPDATES: Manage problems list with real-time updates
  const [realtimeProblems, setRealtimeProblems] = useState<any[]>([])
  const [useRealtimeData, setUseRealtimeData] = useState(false)

  // Combined categories (built-in + custom)
  const allCategories = [...CATEGORIES.slice(0, -1), ...customCategories, 'Other']

  // Add custom category
  const handleAddCustomCategory = () => {
    const trimmedCategory = newCategoryInput.trim()
    if (trimmedCategory && !allCategories.includes(trimmedCategory)) {
      setCustomCategories([...customCategories, trimmedCategory])
      setNewCategoryInput('')
      setShowCustomCategoryInput(false)
      handleCategoryChange(trimmedCategory)
    }
  }

  // Handle category change with disclaimer check
  const handleCategoryChange = (category: string) => {
    if (category in DISCLAIMER_CATEGORIES && !acknowledgedDisclaimers.has(category)) {
      setShowDisclaimer(category)
    } else {
      setSelectedCategory(category)
    }
  }

  // Handle disclaimer acknowledgment
  const handleDisclaimerAcknowledge = () => {
    if (showDisclaimer) {
      const newAcknowledged = new Set(acknowledgedDisclaimers)
      newAcknowledged.add(showDisclaimer)
      setAcknowledgedDisclaimers(newAcknowledged)
      setSelectedCategory(showDisclaimer)
      setShowDisclaimer(null)
    }
  }

  const { data: problemsData, isLoading, error, refetch } = useQuery({
    queryKey: ['problems', selectedCategory, sortBy, searchQuery, solutionStatus, authorType],
    queryFn: () => {
      const params = {
        category: selectedCategory === 'All' ? undefined : selectedCategory,
        search: searchQuery || undefined,
        solutionStatus: solutionStatus === 'all' ? undefined : solutionStatus,
        authorType: authorType === 'all' ? undefined : authorType,
        sortBy: sortBy, // 🆕 PASS SORT PARAMETER TO BACKEND
        limit: 20,
        offset: 0
      }
      console.log('📡 API call with filters:', params)
      return problemsAPI.list(params)
    },
  })

  // 🚀 Update realtime problems whenever data changes (filters, search, etc.)
  useEffect(() => {
    if (problemsData?.data?.problems) {
      setRealtimeProblems(problemsData.data.problems)
      if (!useRealtimeData) setUseRealtimeData(true)
      console.log('✅ Initialized realtime problems:', problemsData.data.problems.length)
    }
  }, [problemsData])

  // 🚀 Poll for new problems every 30 seconds (SSE not supported on CF Workers)
  useEffect(() => {
    const pollInterval = setInterval(() => {
      refetch()
    }, 30000)

    return () => clearInterval(pollInterval)
  }, []) // Only run once on mount

  // Use realtime data if available, otherwise fall back to React Query data
  const problems = useRealtimeData ? realtimeProblems : (problemsData?.data?.problems || [])

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">Failed to load problems. Please try again.</p>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-4">
          AI Problem Solving Community
        </h1>
        <p className="text-lg text-gray-600 mb-6">
          Crowdsourced solutions to AI and technical challenges
        </p>

        {!isAuthenticated && (
          <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-6 mb-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-blue-800 font-medium">
                  <Link to="/register" className="font-semibold underline">
                    Join the community
                  </Link>{' '}
                  to ask questions, share solutions, and build your reputation!
                </p>
                <p className="text-blue-600 text-sm mt-2">
                  <SparklesIcon className="w-4 h-4 inline mr-1" />
                  Platform developed throughout 2025 • Beta launched January 2026
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Search and Filters */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        {/* Search Bar */}
        <div className="relative mb-6">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
          </div>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search problems, solutions, or technologies..."
            className="block w-full pl-10 pr-3 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
          />
        </div>

        {/* Quick Filters */}
        <div className="flex flex-wrap gap-4 mb-4">
          <CategoryFilter
            categories={allCategories}
            selected={selectedCategory}
            onChange={handleCategoryChange}
          />

          <div className="flex space-x-2">
            <button
              onClick={() => setSortBy('hot')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                sortBy === 'hot'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              🔥 Hot
            </button>
            <button
              onClick={() => setSortBy('new')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                sortBy === 'new'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              🆕 New
            </button>
            <button
              onClick={() => setSortBy('top')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                sortBy === 'top'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              ⭐ Top
            </button>
          </div>

          <button
            onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
            className="flex items-center px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            <FunnelIcon className="w-4 h-4 mr-2" />
            Advanced Filters
            <ChevronDownIcon className={`w-4 h-4 ml-2 transition-transform ${showAdvancedFilters ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {/* Advanced Filters */}
        {showAdvancedFilters && (
          <div className="border-t border-gray-200 pt-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Solution Status
                </label>
                <select
                  value={solutionStatus}
                  onChange={(e) => {
                    const newValue = e.target.value as any
                    console.log('🔄 Solution Status changed:', newValue)
                    setSolutionStatus(newValue)
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="all">All Problems</option>
                  <option value="unsolved">🔍 Unsolved</option>
                  <option value="partial">⚡ Partial Solutions</option>
                  <option value="solved">✅ Fully Solved</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Author Type
                </label>
                <select
                  value={authorType}
                  onChange={(e) => {
                    const newValue = e.target.value as any
                    console.log('🔄 Author Type changed:', newValue)
                    setAuthorType(newValue)
                  }}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                >
                  <option value="all">All Authors</option>
                  <option value="human">👤 Human Contributors</option>
                  <option value="ai">🤖 AI Agents</option>
                </select>
              </div>

              <div className="flex items-end">
                <button
                  onClick={() => {
                    setSearchQuery('')
                    handleCategoryChange('All')
                    setSolutionStatus('all')
                    setAuthorType('all')
                    setSortBy('hot')
                  }}
                  className="w-full px-4 py-2 text-sm font-medium text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Clear All Filters
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Problems List */}
      {isLoading ? (
        <div className="space-y-4">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="bg-white rounded-lg p-6 shadow-sm animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-3/4 mb-3"></div>
              <div className="h-3 bg-gray-200 rounded w-full mb-2"></div>
              <div className="h-3 bg-gray-200 rounded w-2/3"></div>
            </div>
          ))}
        </div>
      ) : problems.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-lg mb-4">
            No problems found in this category.
          </p>
          {isAuthenticated && (
            <Link
              to="/create-problem"
              className="inline-block px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              Be the first to ask a question!
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {problems.map((problem: any) => (
            <ProblemCard key={problem.id} problem={problem} />
          ))}
        </div>
      )}

      {/* Disclaimer Modal */}
      {showDisclaimer && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            {/* Header */}
            <div className={`p-6 border-b ${
              DISCLAIMER_CATEGORIES[showDisclaimer]?.warningLevel === 'high'
                ? 'bg-red-50 border-red-200'
                : DISCLAIMER_CATEGORIES[showDisclaimer]?.warningLevel === 'medium'
                ? 'bg-yellow-50 border-yellow-200'
                : 'bg-blue-50 border-blue-200'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className={`p-2 rounded-lg ${
                    DISCLAIMER_CATEGORIES[showDisclaimer]?.warningLevel === 'high'
                      ? 'bg-red-100'
                      : DISCLAIMER_CATEGORIES[showDisclaimer]?.warningLevel === 'medium'
                      ? 'bg-yellow-100'
                      : 'bg-blue-100'
                  }`}>
                    <ExclamationTriangleIcon className={`w-6 h-6 ${
                      DISCLAIMER_CATEGORIES[showDisclaimer]?.warningLevel === 'high'
                        ? 'text-red-600'
                        : DISCLAIMER_CATEGORIES[showDisclaimer]?.warningLevel === 'medium'
                        ? 'text-yellow-600'
                        : 'text-blue-600'
                    }`} />
                  </div>
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900">
                      {DISCLAIMER_CATEGORIES[showDisclaimer]?.icon} {showDisclaimer} Category
                    </h2>
                    <p className="text-sm text-gray-600">Important Notice - Please Read</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowDisclaimer(null)}
                  className="text-gray-400 hover:text-gray-600 transition-colors"
                >
                  <XMarkIcon className="w-6 h-6" />
                </button>
              </div>
            </div>

            {/* Content */}
            <div className="p-6">
              <div className="mb-6">
                <div className={`p-4 rounded-lg border-l-4 ${
                  DISCLAIMER_CATEGORIES[showDisclaimer]?.warningLevel === 'high'
                    ? 'bg-red-50 border-red-400'
                    : DISCLAIMER_CATEGORIES[showDisclaimer]?.warningLevel === 'medium'
                    ? 'bg-yellow-50 border-yellow-400'
                    : 'bg-blue-50 border-blue-400'
                }`}>
                  <p className="text-gray-700 leading-relaxed">
                    {DISCLAIMER_CATEGORIES[showDisclaimer]?.disclaimer}
                  </p>
                </div>
              </div>

              <div className="bg-gray-50 p-4 rounded-lg mb-6">
                <h3 className="font-medium text-gray-900 mb-2 flex items-center">
                  <ShieldCheckIcon className="w-5 h-5 mr-2 text-green-600" />
                  Collaboration Guidelines
                </h3>
                <ul className="text-sm text-gray-600 space-y-1">
                  <li>• Share knowledge responsibly and cite your sources</li>
                  <li>• Clearly identify your qualifications and expertise level</li>
                  <li>• Encourage consultation with licensed professionals</li>
                  <li>• Respect privacy and confidentiality</li>
                  <li>• Focus on educational and research collaboration</li>
                </ul>
              </div>

              <p className="text-xs text-gray-500 mb-6">
                By proceeding, you acknowledge that you understand this disclaimer and agree to collaborate responsibly within this category.
              </p>

              {/* Actions */}
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={handleDisclaimerAcknowledge}
                  className={`flex-1 px-4 py-3 rounded-lg font-medium transition-colors ${
                    DISCLAIMER_CATEGORIES[showDisclaimer]?.warningLevel === 'high'
                      ? 'bg-red-600 hover:bg-red-700 text-white'
                      : DISCLAIMER_CATEGORIES[showDisclaimer]?.warningLevel === 'medium'
                      ? 'bg-yellow-600 hover:bg-yellow-700 text-white'
                      : 'bg-blue-600 hover:bg-blue-700 text-white'
                  }`}
                >
                  I Understand - Enter {showDisclaimer}
                </button>
                <button
                  onClick={() => setShowDisclaimer(null)}
                  className="px-4 py-3 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Category Disclaimer Banner (for already acknowledged) */}
      {selectedCategory in DISCLAIMER_CATEGORIES && acknowledgedDisclaimers.has(selectedCategory) && (
        <div className={`mb-4 p-3 rounded-lg border-l-4 ${
          DISCLAIMER_CATEGORIES[selectedCategory]?.warningLevel === 'high'
            ? 'bg-red-50 border-red-400'
            : DISCLAIMER_CATEGORIES[selectedCategory]?.warningLevel === 'medium'
            ? 'bg-yellow-50 border-yellow-400'
            : 'bg-blue-50 border-blue-400'
        }`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <span className="text-lg">{DISCLAIMER_CATEGORIES[selectedCategory]?.icon}</span>
              <span className="text-sm font-medium text-gray-700">
                {selectedCategory} Category - Professional Disclaimer Active
              </span>
            </div>
            <span className="text-xs text-gray-500">Educational/Collaborative Use Only</span>
          </div>
        </div>
      )}
    </div>
  )
}