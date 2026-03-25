import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { followAPI } from '../services/api'
import { useAuthStore } from '../stores/authStore'
import FollowButton from './FollowButton'

interface FollowersListProps {
  userId: number
}

export default function FollowersList({ userId }: FollowersListProps) {
  const [tab, setTab] = useState<'followers' | 'following'>('followers')
  const { isAuthenticated, user: me } = useAuthStore()
  const [followingSet, setFollowingSet] = useState<Set<number>>(new Set())

  const { data: followersData } = useQuery({
    queryKey: ['followers', userId],
    queryFn: () => followAPI.followers(userId),
  })

  const { data: followingData } = useQuery({
    queryKey: ['following', userId],
    queryFn: () => followAPI.following(userId),
  })

  const followers = followersData?.data?.followers || []
  const following = followingData?.data?.following || []
  const currentList = tab === 'followers' ? followers : following

  // Batch is-following check
  useEffect(() => {
    if (!isAuthenticated || currentList.length === 0) return
    const ids = currentList.map((u: any) => u.id).filter((id: number) => id !== me?.id)
    if (ids.length === 0) return
    followAPI.isFollowingBatch(ids).then(res => {
      setFollowingSet(new Set(res.data?.following || []))
    }).catch(() => {})
  }, [tab, followers.length, following.length, isAuthenticated])

  const tabClass = (t: string) =>
    `px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
      tab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
    }`

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200">
      <div className="flex border-b border-gray-200">
        <button className={tabClass('followers')} onClick={() => setTab('followers')}>
          Followers ({followersData?.data?.count || 0})
        </button>
        <button className={tabClass('following')} onClick={() => setTab('following')}>
          Following ({followingData?.data?.count || 0})
        </button>
      </div>

      <div className="divide-y divide-gray-100">
        {currentList.length === 0 ? (
          <p className="text-center text-gray-500 text-sm py-8">
            {tab === 'followers' ? 'No followers yet' : 'Not following anyone yet'}
          </p>
        ) : (
          currentList.map((u: any) => (
            <div key={u.id} className="flex items-center justify-between px-4 py-3">
              <Link to={`/profile/${u.username}`} className="flex items-center space-x-3 hover:opacity-80">
                <div className="w-9 h-9 bg-blue-100 rounded-full flex items-center justify-center flex-shrink-0">
                  <span className="text-sm font-bold text-blue-600">{u.username?.charAt(0).toUpperCase()}</span>
                </div>
                <div>
                  <div className="font-medium text-gray-900 text-sm">{u.username}</div>
                  <div className="text-xs text-gray-500">{u.reputation} rep</div>
                </div>
              </Link>
              {isAuthenticated && me?.id !== u.id && (
                <FollowButton
                  userId={u.id}
                  initialFollowing={followingSet.has(u.id)}
                  onCountChange={() => {}}
                />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
