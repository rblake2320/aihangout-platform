import {SELF,env} from 'cloudflare:test';
import {it,expect} from 'vitest';

it('records removal and replacement permanently even with no verifier read between writes',async()=>{
  env.PROFILEPAYS_TEST_ENABLED='true';
  const call=(path,method='GET',body,headers={})=>SELF.fetch('https://aihangout.ai/api'+path,{method,headers:{'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.238',...headers},...(body?{body:JSON.stringify(body)}:{})});
  const owner=await (await call('/auth/register','POST',{username:'breach_owner',email:'breach_owner@example.test',password:'test-Only-long-pass123!',aiAgentType:'human'})).json();
  const auth={Authorization:'Bearer '+owner.token}, original=crypto.randomUUID();
  const set=id=>call('/users/me/live-profile','PUT',{profileId:id},auth);
  await set(original);
  const g=await (await call('/profilepays/grant','POST',{},auth)).json(),gh={'X-ProfilePays-Grant':g.token};
  const id=crypto.randomUUID(),path='/profilepays/assignments/'+id,b={assetKey:'blue',durationSeconds:300,originalKey:g.normal.key};
  expect((await call(path,'PUT',b,gh)).status).toBe(200);
  expect((await call(path+'/renew','POST',{},gh)).status).toBe(200);
  await set(original); // No-op must not break an uninterrupted contract.
  expect((await (await call('/users/by-username/breach_owner/placement')).json()).placement.id).toBe(id);
  await set(null);
  await set(original); // No verifier read occurs between these mutations.
  const receipt=await (await call(path,'GET',undefined,gh)).json();
  expect(receipt.breachReason).toBe('user_override');
  expect(receipt.breachedAt).toBeGreaterThan(0);
  expect(receipt.stopped).toBe(true);
  expect((await (await call('/users/by-username/breach_owner/placement')).json()).placement).toBe(null);
  expect((await (await call(path,'PUT',b,gh)).json()).state).toBe('ended');
  expect((await call(path+'/renew','POST',{},gh)).status).toBe(409);
  expect((await (await call(path,'GET',undefined,gh)).json()).breachedAt).toBe(receipt.breachedAt);
  expect((await (await call('/users/by-username/breach_owner/placement')).json()).normal.profileId).toBe(original);
  await expect(env.AIHANGOUT_DB.prepare('UPDATE pp_assignments SET stopped=0,breached_at=NULL,breach_reason=NULL WHERE id=?').bind(id).run()).rejects.toThrow();
  for (const mode of ['replace','remove_assignment']) {
    const next='/profilepays/assignments/'+crypto.randomUUID();
    expect((await call(next,'PUT',b,gh)).status).toBe(200);
    expect((await call(next+'/renew','POST',{},gh)).status).toBe(200);
    if(mode==='replace') { await set(crypto.randomUUID());await set(original); }
    else { await call(next,'DELETE',undefined,gh); }
    const proof=await (await call(next,'GET',undefined,gh)).json();
    expect(proof.breachReason).toBe(mode==='replace'?'user_override':'placement_removed');
    expect((await (await call(next,'PUT',b,gh)).json()).state).toBe('ended');
    expect((await call(next+'/renew','POST',{},gh)).status).toBe(409);
  }
});

it('enforces scoped grants, exclusive placement, expiry and baseline preservation in real D1',async()=>{
  env.PROFILEPAYS_TEST_ENABLED='true';
  const h={'Content-Type':'application/json','CF-Connecting-IP':'203.0.113.239'};
  const call=(path,method='GET',body,headers={})=>SELF.fetch('https://aihangout.ai/api'+path,{method,headers:{...h,...headers},...(body?{body:JSON.stringify(body)}:{})});
  const register=async name=>(await call('/auth/register','POST',{username:name,email:name+'@example.test',password:'test-Only-long-pass123!',aiAgentType:'human'})).json();
  const owner=await register('placement_owner'),other=await register('placement_other');
  expect((await call('/profilepays/grant','POST')).status).toBe(401);
  const issue=async token=>(await call('/profilepays/grant','POST',{}, {Authorization:'Bearer '+token})).json();
  const g=await issue(owner.token),g2=await issue(other.token),gh={'X-ProfilePays-Grant':g.token};
  const id=crypto.randomUUID(),b={assetKey:'blue',durationSeconds:30,originalKey:g.normal.key};
  expect((await call('/profilepays/assignments/'+id,'PUT',b)).status).toBe(401);
  expect((await call('/profilepays/assignments/'+id,'PUT',{...b,assetKey:'https://evil.test/x'},gh)).status).toBe(400);
  expect((await call('/profilepays/assignments/'+id,'PUT',b,gh)).status).toBe(200);
  expect((await call('/profilepays/assignments/'+id,'PUT',b,gh)).status).toBe(200);
  expect((await call('/profilepays/assignments/'+crypto.randomUUID(),'PUT',b,gh)).status).toBe(409);
  expect((await call('/profilepays/assignments/'+id,'PUT',b,{'X-ProfilePays-Grant':g2.token})).status).toBe(409);
  const publicState=async()=>(await call('/users/by-username/placement_owner/placement')).json();
  expect((await publicState()).placement.id).toBe(id);
  const started=await (await call('/profilepays/assignments/'+id+'/renew','POST',{},gh)).json();
  const renewed=await (await call('/profilepays/assignments/'+id+'/renew','POST',{},gh)).json();
  expect(renewed).toEqual(started);expect(started.endsAt-started.startsAt).toBe(30000);
  await env.AIHANGOUT_DB.prepare('UPDATE pp_assignments SET lease_until=? WHERE id=?').bind(Date.now()-1,id).run();
  expect((await publicState()).placement).toBe(null);
  expect((await call('/profilepays/assignments/'+id+'/renew','POST',{},gh)).status).toBe(409);
  expect((await (await call('/profilepays/assignments/'+id,'PUT',b,gh)).json()).state).toBe('ended');
  const next=crypto.randomUUID();await call('/profilepays/assignments/'+next,'PUT',b,gh);
  const baseline=crypto.randomUUID();await call('/users/me/live-profile','PUT',{profileId:baseline},{Authorization:'Bearer '+owner.token});
  expect((await publicState()).placement).toBe(null);
  await call('/profilepays/assignments/'+next,'DELETE',undefined,gh);
  expect((await publicState()).normal.profileId).toBe(baseline);
  await call('/profilepays/grant','DELETE',undefined,{Authorization:'Bearer '+owner.token});
  expect((await call('/profilepays/connection','GET',undefined,gh)).status).toBe(401);
  expect(JSON.stringify(await publicState())).not.toContain(g.token);
  env.PROFILEPAYS_TEST_ENABLED='false';
  expect((await call('/profilepays/grant','POST',{}, {Authorization:'Bearer '+owner.token})).status).toBe(503);
});
