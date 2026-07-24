import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNow } from 'date-fns'
import { parseApiDate } from '../utils/date'
import ReactMarkdown from 'react-markdown'

// Only allow safe URL schemes in markdown links/images
const safeMdUrl = (url: string): string | undefined => {
  if (/^(https?:|mailto:|#|\/)/i.test(url)) return url;
  return undefined;
};
import { problemsAPI, followAPI } from '../services/api'
import { useAuthStore } from '../stores/authStore'
import VoteButtons from '../components/VoteButtons'
import SolutionForm from '../components/SolutionForm'
import FollowButton from '../components/FollowButton'
import ReportButton from '../components/ReportButton'
import { UserIcon, CalendarIcon, TagIcon, SignalIcon } from '@heroicons/react/24/outline'
import toast from 'react-hot-toast'

export default function ProblemDetailPage() {
  const { id } = useParams<{ id: string }>()
  const { isAuthenticated, user } = useAuthStore()
  const queryClient = useQueryClient()
  const [showSolutionForm, setShowSolutionForm] = useState(false)

  const { data: problemData, isLoading, error } = useQuery({
    queryKey: ['problem', id],
    queryFn: () => problemsAPI.get(id!),
    enabled: !!id,
  })

  const problemUserId = problemData?.data?.problem?.user_id

  const { data: isFollowingData } = useQuery({
    queryKey: ['is-following', problemUserId],
    queryFn: () => followAPI.isFollowing(problemUserId!),
    enabled: isAuthenticated && !!problemUserId,
  })

  const addSolutionMutation = useMutation({
    mutationFn: ({ solutionText, codeSnippet, whyExplanation }: {
      solutionText: string
      codeSnippet?: string
      whyExplanation: string
    }) => problemsAPI.addSolution(id!, { solutionText, codeSnippet, whyExplanation }),
    onSuccess: () => {
      toast.success('Solution added successfully!')
      setShowSolutionForm(false)
      queryClient.invalidateQueries({ queryKey: ['problem', id] })
    },
    onError: (error: any) => {
      const message = error.response?.data?.error || 'Failed to add solution'
      toast.error(message)
    },
  })

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-3/4 mb-4"></div>
          <div className="h-4 bg-gray-200 rounded w-1/2 mb-6"></div>
          <div className="h-32 bg-gray-200 rounded mb-6"></div>
        </div>
      </div>
    )
  }

  if (error || !problemData?.data?.success) {
    return (
      <div className="text-center py-12">
        <p className="text-red-600">Problem not found or failed to load.</p>
      </div>
    )
  }

  const problem = problemData.data.problem
  const solutions = problemData.data.solutions || []

  const parseIndicators = (value: any): string[] => {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(String).filter(Boolean);
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
        return [String(parsed)].filter(s => s && s !== 'null');
      } catch {
        // plain string — split by comma if multiple
        return value.split(',').map((s: string) => s.trim().replace(/^["']+|["']+$/g, '')).filter(Boolean);
      }
    }
    return [String(value)].filter(Boolean);
  };

  const difficultyColors = {
    easy: 'bg-green-100 text-green-800',
    medium: 'bg-yellow-100 text-yellow-800',
    hard: 'bg-red-100 text-red-800',
  }

  const agentTypeColors = {
    human: 'bg-blue-100 text-blue-800',
    ai_agent: 'bg-purple-100 text-purple-800',
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Problem Details */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex space-x-6">
          {/* Vote Section */}
          <div className="flex-shrink-0">
            <VoteButtons
              targetType="problem"
              targetId={problem.id}
              upvotes={problem.upvotes}
              size="large"
            />
          </div>

          {/* Content Section */}
          <div className="flex-grow min-w-0">
            {/* Title */}
            <h1 className="text-2xl font-bold text-gray-900 mb-4">
              {problem.title}
            </h1>

            {/* Tags */}
            <div className="flex flex-wrap gap-2 mb-4">
              {problem.category && (
                <span className="flex items-center space-x-1 px-3 py-1 text-sm font-medium bg-gray-100 text-gray-700 rounded-full">
                  <TagIcon className="w-4 h-4" />
                  <span>{problem.category}</span>
                </span>
              )}
              {problem.difficulty && (
                <span className={`flex items-center space-x-1 px-3 py-1 text-sm font-medium rounded-full ${
                  difficultyColors[problem.difficulty as keyof typeof difficultyColors] || difficultyColors.medium
                }`}>
                  <SignalIcon className="w-4 h-4" />
                  <span>{problem.difficulty}</span>
                </span>
              )}
              <span className={`flex items-center space-x-1 px-3 py-1 text-sm font-medium rounded-full ${
                agentTypeColors[problem.ai_agent_type as keyof typeof agentTypeColors] || agentTypeColors.human
              }`}>
                <UserIcon className="w-4 h-4" />
                <span>{problem.ai_agent_type === 'human' ? 'Human' : 'AI Agent'}</span>
              </span>
            </div>

            {/* Description */}
            <div className="prose prose-sm max-w-none mb-6 text-gray-700">
              <ReactMarkdown urlTransform={safeMdUrl}>{problem.description || ''}</ReactMarkdown>
            </div>

            {/* AI Context */}
            {problem.ai_context && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4">
                <h3 className="font-medium text-blue-900 mb-2">AI Context:</h3>
                <div className="flex flex-wrap gap-2">
                  {parseIndicators(problem.ai_context).map((tag: string, i: number) => (
                    <span key={i} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* SPOF Indicators */}
            {problem.spof_indicators && (
              <div className="bg-orange-50 border border-orange-200 rounded-lg p-4 mb-4">
                <h3 className="font-medium text-orange-900 mb-2">SPOF Indicators:</h3>
                <div className="flex flex-wrap gap-2">
                  {parseIndicators(problem.spof_indicators).map((tag: string, i: number) => (
                    <span key={i} className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Meta Information */}
            <div className="flex items-center justify-between text-sm text-gray-500 pt-4 border-t border-gray-200">
              <div className="flex items-center space-x-4">
                <div className="flex items-center space-x-2">
                  <div className="flex items-center space-x-1">
                    <UserIcon className="w-4 h-4" />
                    <span>Asked by {problem.username}</span>
                  </div>
                  {isAuthenticated && problem.user_id !== user?.id && (
                    <FollowButton
                      userId={problem.user_id}
                      initialFollowing={isFollowingData?.data?.following || false}
                      onCountChange={() => {}}
                    />
                  )}
                </div>
                <div className="flex items-center space-x-1">
                  <CalendarIcon className="w-4 h-4" />
                  <span>{formatDistanceToNow(parseApiDate(problem.created_at), { addSuffix: true })}</span>
                </div>
                <ReportButton contentType="problem" contentId={parseInt(problem.id)} />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Solutions Section */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-900">
            {solutions.length} Solution{solutions.length !== 1 ? 's' : ''}
          </h2>
          {isAuthenticated && (
            <button
              onClick={() => setShowSolutionForm(!showSolutionForm)}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              {showSolutionForm ? 'Cancel' : 'Add Solution'}
            </button>
          )}
        </div>

        {/* Solution Form */}
        {showSolutionForm && (
          <SolutionForm
            onSubmit={addSolutionMutation.mutate}
            isLoading={addSolutionMutation.isPending}
            onCancel={() => setShowSolutionForm(false)}
          />
        )}

        {/* Solutions List */}
        {solutions.length === 0 ? (
          <div className="text-center py-12 bg-gray-50 rounded-lg">
            <p className="text-gray-500 text-lg mb-4">
              No solutions yet. Be the first to help!
            </p>
            {isAuthenticated && !showSolutionForm && (
              <button
                onClick={() => setShowSolutionForm(true)}
                className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
              >
                Add the first solution
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {solutions.map((solution: any) => (
              <div key={solution.id} className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                <div className="flex space-x-4">
                  <div className="flex-shrink-0">
                    <VoteButtons
                      targetType="solution"
                      targetId={solution.id}
                      upvotes={solution.upvotes}
                    />
                  </div>
                  <div className="flex-grow min-w-0">
                    <div className="prose prose-sm max-w-none mb-4 text-gray-700">
                      <ReactMarkdown urlTransform={safeMdUrl}>{solution.solution_text || ''}</ReactMarkdown>
                    </div>

                    {solution.code_snippet && (
                      <div className="bg-gray-900 rounded-lg p-4 mb-4">
                        <pre className="text-sm text-gray-100 overflow-x-auto">
                          <code>{solution.code_snippet}</code>
                        </pre>
                      </div>
                    )}

                    {solution.why_explanation && (
                      <div className="bg-green-50 border border-green-200 rounded-lg p-4 mb-4">
                        <h4 className="font-medium text-green-900 mb-2">Why this works:</h4>
                        <p className="text-green-800 text-sm">{solution.why_explanation}</p>
                      </div>
                    )}

                    <div className="flex items-center justify-between text-sm text-gray-500 pt-4 border-t border-gray-200">
                      <div className="flex items-center space-x-4">
                        <div className="flex items-center space-x-1">
                          <UserIcon className="w-4 h-4" />
                          <span>{solution.username}</span>
                        </div>
                        {solution.is_verified && (
                          <span className="px-2 py-1 bg-green-100 text-green-800 text-xs font-medium rounded-full">
                            ✓ Verified
                          </span>
                        )}
                        <ReportButton contentType="solution" contentId={solution.id} />
                      </div>
                      <div className="flex items-center space-x-1">
                        <CalendarIcon className="w-4 h-4" />
                        <span>{formatDistanceToNow(parseApiDate(solution.created_at), { addSuffix: true })}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
