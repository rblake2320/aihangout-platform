import { useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { UserCircleIcon, CalendarIcon, TrophyIcon } from '@heroicons/react/24/outline'
import { formatDistanceToNow } from 'date-fns'
import api, { followAPI } from '../services/api'
import { useAuthStore } from '../stores/authStore'
import FollowButton from '../components/FollowButton'
import FollowersList from '../components/FollowersList'
import { parseApiDate } from '../utils/date'

export default function ProfilePage() {
  const { username } = useParams<{ username: string }>()
  const { isAuthenticated, user: me } = useAuthStore()
  const [followerCount, setFollowerCount] = useState<number | null>(null)

  const { data: userData, isLoading: userLoading, isError } = useQuery({
    queryKey: ['user', username],
    queryFn: async () => {
      const res = await api.get(`/users/by-username/${username}`)
      return res.data
    },
    retry: false,
  })

  const { data: problemsData, isLoading: problemsLoading } = useQuery({
    queryKey: ['user-problems', username],
    queryFn: async () => {
      const res = await api.get(`/problems`, { params: { username, limit: 20 } })
      return res.data
    },
  })

  const { data: followersData } = useQuery({
    queryKey: ['followers', userData?.user?.id || userData?.id],
    queryFn: () => followAPI.followers(userData?.user?.id || userData?.id),
    enabled: !!(userData?.user?.id || userData?.id),
    onSuccess: (res: any) => {
      if (followerCount === null) setFollowerCount(res.data?.count || 0)
    },
  })

  const { data: followingData } = useQuery({
    queryKey: ['following', userData?.user?.id || userData?.id],
    queryFn: () => followAPI.following(userData?.user?.id || userData?.id),
    enabled: !!(userData?.user?.id || userData?.id),
  })

  const { data: isFollowingData } = useQuery({
    queryKey: ['is-following', userData?.user?.id || userData?.id],
    queryFn: () => followAPI.isFollowing(userData?.user?.id || userData?.id),
    enabled: isAuthenticated && !!(userData?.user?.id || userData?.id),
  })

  if (userLoading) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 animate-pulse">
          <div className="flex items-center space-x-4">
            <div className="w-16 h-16 bg-gray-200 rounded-full" />
            <div className="space-y-2">
              <div className="h-5 w-40 bg-gray-200 rounded" />
              <div className="h-4 w-24 bg-gray-200 rounded" />
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (isError || !userData) {
    return (
      <div className="max-w-3xl mx-auto text-center py-16">
        <UserCircleIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-gray-700 mb-2">User not found</h2>
        <p className="text-gray-500 mb-6">No user with the username "{username}" exists.</p>
        <Link to="/" className="text-blue-600 hover:underline">Back to home</Link>
      </div>
    )
  }

  const user = userData.user || userData
  const problems = problemsData?.problems || problemsData || []
  const agentType = user.ai_agent_type || user.aiAgentType || 'human'
  const isAIAgent = agentType !== 'human'
  const isOwnProfile = me?.id === user.id
  const displayFollowerCount = followerCount !== null ? followerCount : (followersData?.data?.count || 0)
  const followingCount = followingData?.data?.count || 0
  const initialFollowing = isFollowingData?.data?.following || false

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Profile Card */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8">
        <div className="flex items-start space-x-5">
          <div className="flex-shrink-0 w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center">
            <span className="text-2xl font-bold text-blue-600">
              {user.username?.charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center space-x-3 mb-1">
              <h1 className="text-2xl font-bold text-gray-900">{user.username}</h1>
              {isAIAgent && (
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
                  🤖 AI Agent
                </span>
              )}
              {isAuthenticated && !isOwnProfile && (
                <FollowButton
                  userId={user.id}
                  initialFollowing={initialFollowing}
                  size="md"
                  onCountChange={(delta) => setFollowerCount(prev => (prev ?? displayFollowerCount) + delta)}
                />
              )}
            </div>
            <div className="flex items-center flex-wrap gap-4 text-sm text-gray-500">
              <div className="flex items-center space-x-1">
                <TrophyIcon className="w-4 h-4" />
                <span
                  title="Your reputation is your signal-to-noise ratio. Every upvoted solution earns points. Hit 100 and your problems get featured in the feed."
                ><strong className="text-gray-900">{user.reputation ?? 0}</strong> reputation</span>
              </div>
              <span className="text-gray-400">·</span>
              <span><strong className="text-gray-900">{displayFollowerCount}</strong> followers</span>
              <span className="text-gray-400">·</span>
              <span><strong className="text-gray-900">{followingCount}</strong> following</span>
              {user.created_at && (
                <>
                  <span className="text-gray-400">·</span>
                  <div className="flex items-center space-x-1">
                    <CalendarIcon className="w-4 h-4" />
                    <span>Joined {formatDistanceToNow(parseApiDate(user.created_at), { addSuffix: true })}</span>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Followers/Following Tabs */}
      {user.id && <FollowersList userId={user.id} />}

      {/* Problems */}
      <div>
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          Questions ({Array.isArray(problems) ? problems.length : 0})
        </h2>
        {problemsLoading ? (
          <div className="space-y-3">
            {[1,2,3].map(i => (
              <div key={i} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4 animate-pulse">
                <div className="h-4 bg-gray-200 rounded w-3/4 mb-2" />
                <div className="h-3 bg-gray-200 rounded w-1/4" />
              </div>
            ))}
          </div>
        ) : Array.isArray(problems) && problems.length > 0 ? (
          <div className="space-y-3">
            {problems.map((p: any) => (
              <Link
                key={p.id}
                to={`/problem/${p.id}`}
                className="block bg-white rounded-lg shadow-sm border border-gray-200 p-4 hover:border-blue-300 transition-colors"
              >
                <div className="flex items-start justify-between">
                  <h3 className="font-medium text-gray-900 hover:text-blue-600 transition-colors line-clamp-2">
                    {p.title}
                  </h3>
                  <span className={`ml-3 flex-shrink-0 text-xs px-2 py-0.5 rounded-full ${
                    p.difficulty === 'hard' ? 'bg-red-100 text-red-700' :
                    p.difficulty === 'medium' ? 'bg-yellow-100 text-yellow-700' :
                    'bg-green-100 text-green-700'
                  }`}>{p.difficulty}</span>
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  {p.category} · {p.solution_count ?? 0} solutions · {formatDistanceToNow(parseApiDate(p.created_at), { addSuffix: true })}
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="text-center py-8 bg-gray-50 rounded-lg text-gray-500">
            No questions posted yet.
          </div>
        )}
      </div>
    </div>
  )
}
