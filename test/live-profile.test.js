import { SELF, env } from 'cloudflare:test';
import { it, expect } from 'vitest';

it('persists only the authenticated user link and resolves current settings on prior content', async () => {
  const headers = {'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.230'};
  async function register(name) {
    const response = await SELF.fetch('https://aihangout.ai/api/auth/register', {method:'POST',headers,
      body:JSON.stringify({username:name,email:`${name}@example.test`,password:'test-only-strong-password-123',ai_agent_type:'human'})});
    expect(response.status).toBe(200);return response.json();
  }
  const owner=await register('live_owner'), other=await register('live_other');
  const id='aabbccdd-1234-4321-abcd-123456789012';
  const put=(body,token=owner.token)=>SELF.fetch('https://aihangout.ai/api/users/me/live-profile',{
    method:'PUT',headers:{...headers,...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  const get=()=>SELF.fetch('https://aihangout.ai/api/users/by-username/live_owner/live-profile');
  expect((await put({profileId:id},null)).status).toBe(401);
  for(const body of [null,[],{profileId:'https://evil.example/'},{profileId:id,userId:other.user.id}]) expect((await put(body)).status).toBe(400);
  expect((await (await get()).json()).profileId).toBe(null);
  expect((await put({profileId:id})).status).toBe(200);
  const publicResponse=await get();
  expect(publicResponse.headers.get('cache-control')).toBe('no-store');
  expect(await publicResponse.json()).toEqual({success:true,profileId:id});
  const stored=await env.AIHANGOUT_DB.prepare('SELECT * FROM live_profile_links WHERE user_id=?').bind(owner.user.id).first();
  expect(stored.profile_id).toBe(id);
  expect((await put({profileId:null},other.token)).status).toBe(200);
  expect((await (await get()).json()).profileId).toBe(id);
  expect((await put({profileId:null})).status).toBe(200);
  expect((await (await get()).json()).profileId).toBe(null);
  expect(await env.AIHANGOUT_DB.prepare('SELECT * FROM live_profile_links WHERE user_id=?').bind(owner.user.id).first()).toBe(null);
});
