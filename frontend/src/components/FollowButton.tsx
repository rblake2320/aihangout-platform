import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { UserPlusIcon, UserMinusIcon } from '@heroicons/react/24/outline'
import { followAPI } from '../services/api'
import toast from 'react-hot-toast'

interface FollowButtonProps {
  userId: number
  initialFollowing: boolean
  onCountChange?: (delta: number) => void
  size?: 'sm' | 'md'
}

export default function FollowButton({ userId, initialFollowing, onCountChange, size = 'sm' }: FollowButtonProps) {
  const [following, setFollowing] = useState(initialFollowing)
  const queryClient = useQueryClient()
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const previousRef = useRef(initialFollowing)

  const toggleMutation = useMutation({
    mutationFn: () => followAPI.toggle(userId),
    onSuccess: (res) => {
      const newFollowing = res.data?.following ?? !following
      setFollowing(newFollowing)
      if (newFollowing !== previousRef.current) {
        onCountChange?.(newFollowing ? 1 : -1)
      }
      previousRef.current = newFollowing
      queryClient.invalidateQueries({ queryKey: ['followers', userId] })
      queryClient.invalidateQueries({ queryKey: ['is-following', userId] })
      toast.success(newFollowing ? 'Following' : 'Unfollowed')
    },
    onError: () => {
      setFollowing(previousRef.current)
      toast.error('Failed to update follow status')
    },
  })

  useEffect(() => {
    if (!toggleMutation.isPending) {
      setFollowing(initialFollowing)
      previousRef.current = initialFollowing
    }
  }, [initialFollowing, toggleMutation.isPending])

  const handleClick = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      toggleMutation.mutate()
    }, 300)
  }

  const sizeClasses = size === 'md'
    ? 'px-3 py-1.5 text-sm'
    : 'px-2 py-1 text-xs'

  return (
    <button
      onClick={handleClick}
      disabled={toggleMutation.isPending}
      className={`inline-flex items-center space-x-1 rounded-full font-medium transition-colors ${sizeClasses} ${
        following
          ? 'bg-blue-100 text-blue-700 hover:bg-blue-200'
          : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
      } disabled:opacity-50`}
      aria-label={following ? 'Unfollow' : 'Follow'}
    >
      {following ? (
        <><UserMinusIcon className="w-3 h-3" /><span>Following</span></>
      ) : (
        <><UserPlusIcon className="w-3 h-3" /><span>Follow</span></>
      )}
    </button>
  )
}
