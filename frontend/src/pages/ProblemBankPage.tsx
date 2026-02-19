import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import {
  BanknotesIcon,
  FireIcon,
  ClockIcon,
  UsersIcon,
  CurrencyDollarIcon,
  ExclamationTriangleIcon,
  BuildingOffice2Icon,
  GlobeAltIcon
} from '@heroicons/react/24/outline'

interface MajorProblem {
  id: number
  title: string
  description: string
  category: string
  industry: string
  impact_level: 'critical' | 'high' | 'medium'
  estimated_value: number
  affected_users: number
  time_to_solve: string
  source: string
  bounty_amount?: number
  created_at: string
  is_featured: boolean
  tags: string[]
  difficulty: 'beginner' | 'intermediate' | 'advanced' | 'expert'
  company?: string
}

const IMPACT_COLORS = {
  critical: 'bg-red-100 text-red-800',
  high: 'bg-orange-100 text-orange-800',
  medium: 'bg-yellow-100 text-yellow-800'
}

const DIFFICULTY_COLORS = {
  beginner: 'bg-green-100 text-green-800',
  intermediate: 'bg-blue-100 text-blue-800',
  advanced: 'bg-purple-100 text-purple-800',
  expert: 'bg-red-100 text-red-800'
}

export default function ProblemBankPage() {
  const [problems, setProblems] = useState<MajorProblem[]>([])
  const [featured, setFeatured] = useState<MajorProblem[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedCategory, setSelectedCategory] = useState('all')
  const [selectedImpact, setSelectedImpact] = useState('all')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [total, setTotal] = useState(0)
  const [hasNext, setHasNext] = useState(false)
  const [hasPrev, setHasPrev] = useState(false)

  // Track previous filters to detect filter changes vs page changes
  const [prevFilters, setPrevFilters] = useState({ category: 'all', impact: 'all' })

  useEffect(() => {
    const filtersChanged = selectedCategory !== prevFilters.category || selectedImpact !== prevFilters.impact
    if (filtersChanged) {
      setPrevFilters({ category: selectedCategory, impact: selectedImpact })
      if (page !== 1) {
        setPage(1) // This will re-trigger useEffect with page=1
        return       // Skip this fetch — the page change will trigger the correct one
      }
    }
    fetchProblems()
  }, [selectedCategory, selectedImpact, page])

  // Featured problems never change with filters — fetch once on mount
  useEffect(() => {
    fetchFeatured()
  }, [])

  const fetchProblems = async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (selectedCategory !== 'all') params.set('category', selectedCategory)
      if (selectedImpact !== 'all') params.set('impact', selectedImpact)
      params.set('limit', '20')
      params.set('offset', String((page - 1) * 20))

      const response = await fetch(`/api/problem-bank?${params.toString()}`)
      const data = await response.json()

      if (data.success) {
        setProblems(data.problems)
        setTotal(data.total || data.problems.length)
        setTotalPages(data.totalPages || 1)
        setHasNext(data.hasNext || false)
        setHasPrev(data.hasPrev || false)
      }
    } catch (error) {
      console.error('Failed to fetch problem bank:', error)
    } finally {
      setLoading(false)
    }
  }

  const fetchFeatured = async () => {
    try {
      const response = await fetch('/api/problem-bank/featured')
      const data = await response.json()

      if (data.success) {
        setFeatured(data.featured)
      }
    } catch (error) {
      console.error('Failed to fetch featured problems:', error)
    }
  }

  const ProblemCard = ({ problem }: { problem: MajorProblem }) => (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center space-x-2">
          <span className={`px-2 py-1 text-xs font-medium rounded-full ${IMPACT_COLORS[problem.impact_level]}`}>
            {problem.impact_level.toUpperCase()}
          </span>
          <span className={`px-2 py-1 text-xs font-medium rounded-full ${DIFFICULTY_COLORS[problem.difficulty]}`}>
            {problem.difficulty.toUpperCase()}
          </span>
        </div>
        {problem.bounty_amount && (
          <div className="text-right">
            <div className="text-sm text-gray-500">Bounty</div>
            <div className="text-lg font-bold text-green-600">
              ${problem.bounty_amount.toLocaleString()}
            </div>
          </div>
        )}
      </div>

      <h3 className="text-lg font-semibold text-gray-900 mb-2 line-clamp-2">
        {problem.title}
      </h3>

      <p className="text-gray-600 text-sm mb-4 line-clamp-3">
        {problem.description}
      </p>

      <div className="grid grid-cols-2 gap-4 mb-4 text-sm">
        <div className="flex items-center text-gray-500">
          <CurrencyDollarIcon className="w-4 h-4 mr-1" />
          <span>${problem.estimated_value.toLocaleString()} impact</span>
        </div>
        <div className="flex items-center text-gray-500">
          <UsersIcon className="w-4 h-4 mr-1" />
          <span>{problem.affected_users.toLocaleString()} affected</span>
        </div>
        <div className="flex items-center text-gray-500">
          <ClockIcon className="w-4 h-4 mr-1" />
          <span>{problem.time_to_solve}</span>
        </div>
        <div className="flex items-center text-gray-500">
          <BuildingOffice2Icon className="w-4 h-4 mr-1" />
          <span>{problem.industry}</span>
        </div>
      </div>

      {problem.tags && problem.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-4">
          {problem.tags.slice(0, 3).map((tag, index) => (
            <span
              key={index}
              className="px-2 py-1 text-xs bg-blue-50 text-blue-700 rounded"
            >
              {tag}
            </span>
          ))}
          {problem.tags.length > 3 && (
            <span className="px-2 py-1 text-xs bg-gray-50 text-gray-500 rounded">
              +{problem.tags.length - 3}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center justify-between pt-4 border-t border-gray-100">
        <div className="text-sm text-gray-500">
          Source: {problem.source}
          {problem.company && ` • ${problem.company}`}
        </div>
        <Link to={`/problem/${problem.id}`} className="px-4 py-2 bg-blue-600 text-white text-sm rounded-md hover:bg-blue-700 transition-colors inline-block">
          Take Challenge
        </Link>
      </div>
    </div>
  )

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 mb-4 flex items-center">
              <BanknotesIcon className="w-8 h-8 mr-3 text-blue-600" />
              Problem Bank
            </h1>
            <p className="text-lg text-gray-600">
              Major industry problems imported from GitHub Issues, Stack Overflow, and enterprise sources.
              Solve real-world challenges and build your reputation.
            </p>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-600">${problems.reduce((sum, p) => sum + p.estimated_value, 0).toLocaleString()}</div>
            <div className="text-sm text-gray-500">Page Problem Value</div>
          </div>
        </div>
      </div>

      {/* Featured Problems */}
      {featured.length > 0 && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold text-gray-900 mb-4 flex items-center">
            <FireIcon className="w-5 h-5 text-orange-500 mr-2" />
            🔥 High-Value Featured Problems
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {featured.slice(0, 3).map((problem) => (
              <ProblemCard key={problem.id} problem={problem} />
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <h3 className="text-lg font-medium text-gray-900 mb-4">Filter Problems</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Category
            </label>
            <select
              value={selectedCategory}
              onChange={(e) => setSelectedCategory(e.target.value)}
              aria-label="Filter by category"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Categories</option>
              <option value="cloud-infrastructure">Cloud Infrastructure</option>
              <option value="data-processing">Data Processing</option>
              <option value="security">Security</option>
              <option value="ml-ai">Machine Learning</option>
              <option value="performance">Performance</option>
              <option value="scalability">Scalability</option>
              <option value="integration">Integration</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Impact Level
            </label>
            <select
              value={selectedImpact}
              onChange={(e) => setSelectedImpact(e.target.value)}
              aria-label="Filter by impact level"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="all">All Impact Levels</option>
              <option value="critical">Critical ($1M+ impact)</option>
              <option value="high">High ($100K+ impact)</option>
              <option value="medium">Medium ($10K+ impact)</option>
            </select>
          </div>

          <div className="flex items-end">
            <Link to="/create-problem" className="w-full px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors inline-block text-center">
              Submit New Problem
            </Link>
          </div>
        </div>
      </div>

      {/* Problem Grid */}
      {loading && problems.length === 0 ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="text-gray-500 mt-4">Loading problem bank...</p>
        </div>
      ) : problems.length > 0 ? (
        <div className="relative">
          {loading && (
            <div className="absolute inset-0 bg-white/60 z-10 flex items-start justify-center pt-12">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
            </div>
          )}
          <div className={`grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
            {problems.map((problem) => (
              <ProblemCard key={problem.id} problem={problem} />
            ))}
          </div>
        </div>
      ) : (
        <div className="text-center py-12 bg-white rounded-lg border border-gray-200">
          <ExclamationTriangleIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Problems Found</h3>
          <p className="text-gray-500 mb-4">
            No problems match your current filters.
          </p>
          <button
            onClick={() => {
              setSelectedCategory('all')
              setSelectedImpact('all')
            }}
            className="text-blue-600 hover:text-blue-700 font-medium"
          >
            Clear Filters
          </button>
        </div>
      )}

      {/* Pagination */}
      {!loading && problems.length > 0 && (
        <div className="flex items-center justify-center space-x-4 mt-8">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={!hasPrev}
            aria-label="Go to previous page"
            className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Previous
          </button>
          <span className="text-sm text-gray-600">
            Page {page} of {totalPages}
            <span className="text-gray-400 ml-2">({total} total)</span>
          </span>
          <button
            onClick={() => setPage(p => p + 1)}
            disabled={!hasNext}
            aria-label="Go to next page"
            className="px-4 py-2 bg-white border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="mt-12 grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">{total}</div>
          <div className="text-sm text-gray-500">Total Problems</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">
            ${problems.reduce((sum, p) => sum + (p.bounty_amount || 0), 0).toLocaleString()}
          </div>
          <div className="text-sm text-gray-500">Page Bounties</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">
            {problems.reduce((sum, p) => sum + p.affected_users, 0).toLocaleString()}
          </div>
          <div className="text-sm text-gray-500">Page Affected Users</div>
        </div>
        <div className="bg-white rounded-lg border border-gray-200 p-4">
          <div className="text-2xl font-bold text-gray-900">
            {problems.filter(p => p.impact_level === 'critical').length}
          </div>
          <div className="text-sm text-gray-500">Page Critical Issues</div>
        </div>
      </div>
    </div>
  )
}