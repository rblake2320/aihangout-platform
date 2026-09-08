import { SELF, env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { enrollmentProof, b64 } from './mobile-proof-helper.js';
let seq=0;
async function api(path,{method='GET',body,token}={}) {
 const headers={'CF-Connecting-IP':`192.0.2.${++seq}`};
 if(token) headers.Authorization=`Bearer ${token}`;
 if(body!==undefined) headers['Content-Type']='application/json';
 const r=await SELF.fetch('https://example.test'+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:r.status,json:await r.json()};
}
async function user(){const name=`a2gate_${++seq}`;const r=await api('/api/auth/register',{method:'POST',body:{username:name,email:name+'@example.invalid',password:'Synthetic Gate2 password only!',aiAgentType:'human'}});expect(r.status).toBe(200);return {id:r.json.user.id,token:r.json.token};}
const enroll=(u,p)=>api('/api/mobile/devices/enroll',{method:'POST',token:u.token,body:p.body});
async function state(p){const c=await env.AIHANGOUT_DB.prepare('SELECT consumed_at FROM mobile_enrollment_challenges WHERE challenge_id=?').bind(p.body.challengeId).first();const d=await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) n FROM mobile_devices WHERE enrollment_challenge_id=?').bind(p.body.challengeId).first();return {consumed:c.consumed_at!==null,devices:d.n};}
it('A2 concurrent identical proof admits exactly one durable enrollment',async()=>{
 const u=await user(),p=await enrollmentProof(api,u,'a2_concurrent');
 const r=await Promise.all([enroll(u,p),enroll(u,p),enroll(u,p)]);const s=await state(p);
 console.log('A2_GATE2',JSON.stringify({case:'concurrent',statuses:r.map(x=>x.status),state:s}));
 expect(r.map(x=>x.status).sort()).toEqual([200,409,409]);expect(s).toEqual({consumed:true,devices:1});
});
it('A2 owner/key/transcript/encoding binding refuses without consuming legitimate proof',async()=>{
 const u=await user(),stranger=await user(),p=await enrollmentProof(api,u,'a2_binding');
 const other=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const wrong=b64(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},other.privateKey,new TextEncoder().encode(p.challenge.signingPayload)));
 const statuses=[];
 statuses.push((await enroll(stranger,p)).status);
 for(const patch of [{signature:wrong},{agentName:'other_name'},{packageName:'wrong.app'},{signature:b64(new Uint8Array(63))}]) statuses.push((await enroll(u,{body:{...p.body,...patch}})).status);
 const before=await state(p);const ok=await enroll(u,p);
 console.log('A2_GATE2',JSON.stringify({case:'binding',statuses,before,positive:ok.status}));
 expect(statuses).toEqual([409,403,400,400,400]);expect(before).toEqual({consumed:false,devices:0});expect(ok.status).toBe(200);expect(ok.json.assurance).toBe('key_possession_only');expect(ok.json.keySecurityLevel).toBe('unknown');
});
it('A2 consume-write failure rolls back device insert then permits one repaired completion',async()=>{
 const u=await user(),p=await enrollmentProof(api,u,'a2_fault');
 await env.AIHANGOUT_DB.exec("CREATE TRIGGER a2_consume_abort BEFORE UPDATE OF consumed_at ON mobile_enrollment_challenges BEGIN SELECT RAISE(ABORT,'A2_CONTROLLED_CONSUME_FAILURE'); END;");
 const failed=await enroll(u,p);const before=await state(p);
 await env.AIHANGOUT_DB.exec('DROP TRIGGER a2_consume_abort;');
 const ok=await enroll(u,p);const after=await state(p);
 console.log('A2_GATE2',JSON.stringify({case:'consume_atomicity',failed:failed.status,before,positive:ok.status,after}));
 expect(failed.status).toBe(503);expect(before).toEqual({consumed:false,devices:0});expect(ok.status).toBe(200);expect(after).toEqual({consumed:true,devices:1});
});
it('A2 revoke failure rolls back both records; completed revoke rejects stale approval write',async()=>{
 const u=await user(),p=await enrollmentProof(api,u,'a2_revoke');const d=(await enroll(u,p)).json.deviceId;
 const intent=await api('/api/mobile/actions/intent',{method:'POST',token:u.token,body:{deviceId:d,capability:'battery_status_read',targetDescription:'synthetic battery',idempotencyKey:'a2_revocation'}});expect(intent.status).toBe(200);
 const a=intent.json;
 await env.AIHANGOUT_DB.exec("CREATE TRIGGER a2_revoke_abort BEFORE UPDATE OF status ON mobile_action_intents WHEN NEW.status='revoked' BEGIN SELECT RAISE(ABORT,'A2_CONTROLLED_REVOKE_FAILURE'); END;");
 const fail=await api(`/api/mobile/devices/${d}/revoke`,{method:'POST',token:u.token,body:{}});
 const device=await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_devices WHERE device_id=?').bind(d).first();
 const action=await env.AIHANGOUT_DB.prepare('SELECT status FROM mobile_action_intents WHERE action_id=?').bind(a.actionId).first();
 await env.AIHANGOUT_DB.exec('DROP TRIGGER a2_revoke_abort;');
 const ok=await api(`/api/mobile/devices/${d}/revoke`,{method:'POST',token:u.token,body:{}});
 // Models the actual mutation boundary after an earlier active-state read, not a mock SQL engine.
 await expect(env.AIHANGOUT_DB.prepare('INSERT INTO mobile_action_approvals(action_id,approved_by,approved_digest) VALUES(?,?,?)').bind(a.actionId,u.id,a.actionDigest).run()).rejects.toThrow('MOBILE_DEVICE_UNAVAILABLE');
 const count=await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) n FROM mobile_action_approvals WHERE action_id=?').bind(a.actionId).first();
 console.log('A2_GATE2',JSON.stringify({case:'revoke_atomicity',failed:fail.status,device,action,positive:ok.status,approvalRows:count.n}));
 expect(fail.status).toBeGreaterThanOrEqual(500);expect(device.status).toBe('active');expect(action.status).toBe('awaiting_approval');expect(ok.status).toBe(200);expect(count.n).toBe(0);
});
