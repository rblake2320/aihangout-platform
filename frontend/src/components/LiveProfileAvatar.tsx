import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../services/api'

// Build-time override is only for a local acceptance server. Production uses the fixed provider.
const configuredOrigin = import.meta.env.VITE_LIVE_COUNTDOWN_ORIGIN || 'https://electionclock.com'
const provider = new URL(configuredOrigin)
if (provider.origin !== 'https://electionclock.com' && !['localhost', '127.0.0.1'].includes(provider.hostname)) {
  throw new Error('Unsupported live countdown provider')
}

export default function LiveProfileAvatar({username, size = 40}: {username: string; size?: number}) {
  const [generation, setGeneration] = useState(0)
  const [failed, setFailed] = useState(false)
  const {data} = useQuery({
    queryKey: ['live-profile', username],
    queryFn: async () => (await api.get(`/users/by-username/${encodeURIComponent(username)}/live-profile`)).data,
    enabled: !!username, staleTime: 15000, refetchInterval: 30000, retry: false,
  })
  // Re-open periodically so a suspended/broken stream never stays frozen indefinitely.
  useEffect(() => {
    const reconnect = () => { if (!document.hidden) { setFailed(false); setGeneration(n => n + 1) } }
    const timer = setInterval(reconnect, 30000)
    window.addEventListener('online', reconnect)
    document.addEventListener('visibilitychange', reconnect)
    return () => { clearInterval(timer); window.removeEventListener('online', reconnect); document.removeEventListener('visibilitychange', reconnect) }
  }, [])
  useEffect(() => { setFailed(false) }, [data?.profileId])
  if (!data?.profileId || failed) return <span aria-label={username} style={{width:size,height:size,fontSize:size/2}}
    className="inline-flex shrink-0 items-center justify-center rounded-full bg-blue-100 font-bold text-blue-700">{username?.charAt(0).toUpperCase()}</span>
  return <img data-live-profile={data.profileId} src={`${provider.origin}/api/live-profiles/${encodeURIComponent(data.profileId)}.stream?generation=${generation}`}
    width={size} height={size} alt={`${username}'s live election countdown`} className="shrink-0 rounded-full"
    style={{width:size,height:size}} onError={() => setFailed(true)} />
}
