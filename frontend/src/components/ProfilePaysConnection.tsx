import {useState} from 'react'
import api from '../services/api'
export default function ProfilePaysConnection(){
  const [token,setToken]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
  async function change(revoke=false){setBusy(true);try{
    if(revoke){await api.delete('/profilepays/grant',{data:{}});setToken('');setMessage('Permission revoked. Your normal profile is visible again.')}
    else {const {data}=await api.post('/profilepays/grant',{});setToken(data.token);setMessage('Paste this connection code into ProfilePays. It permits static test placements only.')}
  }catch(e:any){setMessage(e.response?.data?.error||'Could not update connection')}finally{setBusy(false)}}
  return <section className="rounded-lg border bg-white p-6 space-y-3"><h2 className="font-semibold text-lg">ProfilePays test placements</h2>
    <p className="text-sm text-gray-600">Temporarily show an approved sponsored test image. Your normal profile stays saved underneath. Test credits have no cash value. You can revoke permission at any time.</p>
    <button className="bg-blue-700 text-white rounded px-4 py-2" disabled={busy} onClick={()=>change()}>Create connection code</button>{' '}
    <button className="border rounded px-4 py-2" disabled={busy} onClick={()=>change(true)}>Revoke ProfilePays</button>
    {token&&<label className="block">Private connection code<input readOnly type="password" value={token} onFocus={e=>{e.currentTarget.type='text';e.currentTarget.select()}} onBlur={e=>e.currentTarget.type='password'} className="block w-full border rounded p-2"/></label>}
    <p role="status">{message}</p></section>
}
