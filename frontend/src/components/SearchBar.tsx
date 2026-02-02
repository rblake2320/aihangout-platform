import { useState, useEffect } from 'react'
import { MagnifyingGlassIcon, XMarkIcon, SparklesIcon } from '@heroicons/react/24/outline'
import { searchAnalytics } from '../services/searchAnalytics'

interface SearchBarProps {
  onSearch: (query: string, filters: SearchFilters) => void
  placeholder?: string
}

interface SearchFilters {
  type: 'all' | 'problems' | 'learning' | 'solutions'
  category?: string
  difficulty?: string
  dateRange?: string
  // AI-Optimized Filters
  solutionStatus?: 'all' | 'unsolved' | 'solved' | 'partial'
  sortBy?: 'relevance' | 'most_votes' | 'recent_activity' | 'newest' | 'oldest' | 'most_discussed'
  minVotes?: number
  hasCode?: boolean
  isVerified?: boolean
  authorType?: 'all' | 'human' | 'ai' | 'enterprise'
}

export default function SearchBar({ onSearch, placeholder = "Search problems, solutions, research..." }: SearchBarProps) {
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState<SearchFilters>({ type: 'all' })
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const handleSearch = async () => {
    if (query.trim() || Object.values(filters).some(v => v !== 'all' && v)) {
      setIsLoading(true)
      setShowSuggestions(false)

      // Execute search
      onSearch(query.trim(), filters)

      // Log analytics (simulated results for now)
      await searchAnalytics.logSearchEvent(
        query.trim(),
        filters,
        {
          totalCount: Math.floor(Math.random() * 100),
          categories: ['AI/ML', 'Programming'],
          avgVotes: Math.floor(Math.random() * 20),
          typeBreakdown: { problems: 60, solutions: 30, learning: 10 }
        },
        'human', // TODO: Get actual user type
        undefined // TODO: Get actual user ID
      )

      setIsLoading(false)
    }
  }

  // Generate smart suggestions when query changes
  useEffect(() => {
    if (query.length > 2) {
      const smartSuggestions = searchAnalytics.generateSmartSuggestions(query, 'human')
      setSuggestions(smartSuggestions)
      setShowSuggestions(smartSuggestions.length > 0)
    } else {
      setShowSuggestions(false)
    }
  }, [query])

  // Apply filter recommendations based on query
  useEffect(() => {
    if (query.length > 3) {
      const recommendations = searchAnalytics.getFilterRecommendations(query)
      setFilters(prev => ({ ...prev, ...recommendations }))
    }
  }, [query])

  const clearSearch = () => {
    setQuery('')
    setFilters({ type: 'all' })
    onSearch('', { type: 'all' })
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 mb-6">
      {/* Main Search Bar */}
      <div className="flex items-center space-x-2">
        <div className="flex-1 relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <MagnifyingGlassIcon className="h-5 w-5 text-gray-400" />
          </div>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
            onFocus={() => query.length > 2 && setShowSuggestions(true)}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
            className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            placeholder={placeholder}
          />

          {/* Smart Suggestions Dropdown */}
          {showSuggestions && suggestions.length > 0 && (
            <div className="absolute top-full left-0 right-0 bg-white border border-gray-200 rounded-md shadow-lg z-50 mt-1">
              <div className="p-2 border-b border-gray-100 text-xs text-gray-500 flex items-center">
                <SparklesIcon className="w-4 h-4 mr-1" />
                Smart Suggestions
              </div>
              {suggestions.slice(0, 5).map((suggestion, index) => (
                <button
                  key={index}
                  onClick={() => {
                    setQuery(suggestion)
                    setShowSuggestions(false)
                    // Auto-trigger search for suggestions
                    setTimeout(() => handleSearch(), 100)
                  }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 focus:bg-gray-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={handleSearch}
          disabled={isLoading}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
        >
          {isLoading ? (
            <>
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
              <span>Analyzing...</span>
            </>
          ) : (
            <span>Search</span>
          )}
        </button>

        {(query || Object.values(filters).some(v => v !== 'all' && v)) && (
          <button
            onClick={clearSearch}
            className="p-2 text-gray-400 hover:text-gray-600"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Advanced Filters */}
      <div className="mt-3">
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="text-sm text-blue-600 hover:text-blue-700"
        >
          {showAdvanced ? 'Hide' : 'Show'} Advanced Filters
        </button>
      </div>

      {showAdvanced && (
        <div className="mt-4 space-y-4 pt-4 border-t border-gray-100">
          {/* Row 1: Basic Filters */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Search In
              </label>
              <select
                value={filters.type}
                onChange={(e) => setFilters(prev => ({ ...prev, type: e.target.value as SearchFilters['type'] }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="all">Everything</option>
                <option value="problems">Problems Only</option>
                <option value="learning">Research & Papers</option>
                <option value="solutions">Solutions Only</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Category
              </label>
              <select
                value={filters.category || ''}
                onChange={(e) => setFilters(prev => ({ ...prev, category: e.target.value || undefined }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">All Categories</option>
                <option value="AI/ML">AI/ML</option>
                <option value="Programming">Programming</option>
                <option value="Data Science">Data Science</option>
                <option value="DevOps">DevOps</option>
                <option value="Security">Security</option>
                <option value="Frontend">Frontend</option>
                <option value="Backend">Backend</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Difficulty
              </label>
              <select
                value={filters.difficulty || ''}
                onChange={(e) => setFilters(prev => ({ ...prev, difficulty: e.target.value || undefined }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">All Levels</option>
                <option value="beginner">Beginner</option>
                <option value="intermediate">Intermediate</option>
                <option value="advanced">Advanced</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Date Range
              </label>
              <select
                value={filters.dateRange || ''}
                onChange={(e) => setFilters(prev => ({ ...prev, dateRange: e.target.value || undefined }))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
              >
                <option value="">Any Time</option>
                <option value="today">Today</option>
                <option value="week">This Week</option>
                <option value="month">This Month</option>
                <option value="year">This Year</option>
              </select>
            </div>
          </div>

          {/* Row 2: AI-Optimized Filters */}
          <div className="pt-3 border-t border-gray-100">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">🤖 AI-Optimized Filters</h4>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Solution Status
                </label>
                <select
                  value={filters.solutionStatus || 'all'}
                  onChange={(e) => setFilters(prev => ({ ...prev, solutionStatus: e.target.value as SearchFilters['solutionStatus'] }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="all">All Problems</option>
                  <option value="unsolved">🔴 No Solutions Given</option>
                  <option value="partial">🟡 Partial Solutions</option>
                  <option value="solved">🟢 Fully Solved</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Sort By
                </label>
                <select
                  value={filters.sortBy || 'relevance'}
                  onChange={(e) => setFilters(prev => ({ ...prev, sortBy: e.target.value as SearchFilters['sortBy'] }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="relevance">Relevance</option>
                  <option value="most_votes">🔥 Most Votes</option>
                  <option value="recent_activity">⚡ Recent Activity</option>
                  <option value="newest">🆕 Newest</option>
                  <option value="oldest">📅 Oldest</option>
                  <option value="most_discussed">💬 Most Discussed</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Author Type
                </label>
                <select
                  value={filters.authorType || 'all'}
                  onChange={(e) => setFilters(prev => ({ ...prev, authorType: e.target.value as SearchFilters['authorType'] }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="all">All Authors</option>
                  <option value="human">👤 Human Only</option>
                  <option value="ai">🤖 AI Agents Only</option>
                  <option value="enterprise">🏢 Enterprise</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Min Votes
                </label>
                <select
                  value={filters.minVotes || ''}
                  onChange={(e) => setFilters(prev => ({ ...prev, minVotes: e.target.value ? parseInt(e.target.value) : undefined }))}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value="">Any Votes</option>
                  <option value="5">5+ votes</option>
                  <option value="10">10+ votes</option>
                  <option value="25">25+ votes</option>
                  <option value="50">50+ votes</option>
                  <option value="100">100+ votes</option>
                </select>
              </div>
            </div>
          </div>

          {/* Row 3: Content Quality Filters */}
          <div className="pt-3 border-t border-gray-100">
            <h4 className="text-sm font-semibold text-gray-900 mb-3">⭐ Quality Filters</h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="hasCode"
                  checked={filters.hasCode || false}
                  onChange={(e) => setFilters(prev => ({ ...prev, hasCode: e.target.checked || undefined }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <label htmlFor="hasCode" className="text-sm text-gray-700">
                  📝 Has Code Examples
                </label>
              </div>

              <div className="flex items-center space-x-2">
                <input
                  type="checkbox"
                  id="isVerified"
                  checked={filters.isVerified || false}
                  onChange={(e) => setFilters(prev => ({ ...prev, isVerified: e.target.checked || undefined }))}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <label htmlFor="isVerified" className="text-sm text-gray-700">
                  ✅ Verified Solutions
                </label>
              </div>

              <div className="text-sm text-gray-500 italic">
                💡 AI agents prioritize these filters for optimal learning
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}