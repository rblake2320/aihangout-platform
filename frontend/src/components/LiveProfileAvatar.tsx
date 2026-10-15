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
  const [now, setNow] = useState(performance.now())
  const [failedPlacement, setFailedPlacement] = useState<string | null>(null)
  const {data:placementData} = useQuery({queryKey:['placement',username],enabled:!!username,
    queryFn:async()=>{const response=await api.get(`/users/by-username/${encodeURIComponent(username)}/placement`);return {...response.data,receivedAt:performance.now()}},
    refetchInterval:3000,staleTime:0,retry:false})
  useEffect(()=>{const timer=setInterval(()=>setNow(performance.now()),500);return()=>clearInterval(timer)},[])
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
  const placement=placementData?.placement
  // Server time plus a monotonic interval survives a phone clock/time-zone change.
  const serverNow=placementData?.observedAt+Math.max(0,now-placementData?.receivedAt)
  const profileId=placementData?.normal ? placementData.normal.profileId : data?.profileId
  if (placement && failedPlacement !== placement.id && serverNow < placement.leaseUntil && (!placement.endsAt || serverNow < placement.endsAt)) return <span className="inline-flex shrink-0 flex-col items-center" style={{width:size}} title={placement.disclosure}>
    <img data-static-placement={placement.id} src={placement.assetUrl} width={size} height={size} alt={`${username}: sponsored test placement`} className="block shrink-0 rounded-full" style={{width:size,height:size,minWidth:size}} onError={()=>setFailedPlacement(placement.id)}/>
    <span className="whitespace-nowrap text-[8px] leading-3 text-gray-700">Ad · test</span></span>
  if (!profileId || failed) return <span aria-label={username} data-normal-profile={username} style={{width:size,height:size,fontSize:size/2}}
    className="inline-flex shrink-0 items-center justify-center rounded-full bg-blue-100 font-bold text-blue-700">{username?.charAt(0).toUpperCase()}</span>
  return <img data-live-profile={profileId} src={`${provider.origin}/api/live-profiles/${encodeURIComponent(profileId)}.stream?generation=${generation}`}
    width={size} height={size} alt={`${username}'s live election countdown`} className="shrink-0 rounded-full"
    style={{width:size,height:size}} onError={() => setFailed(true)} />
}
