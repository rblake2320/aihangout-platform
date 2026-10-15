// Test-credit-only connector. It never replaces the underlying normal profile setting.
export function registerProfilePays(router, {authenticate, safeJsonParse, jsonResponse}) {
  const assets = new Set(['blue', 'green']);
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
  const hash = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(n=>n.toString(16).padStart(2,'0')).join('');
  const enabled = env => env.PROFILEPAYS_TEST_ENABLED === 'true';
  const reply = (data,status=200) => jsonResponse(data,{status,headers:{'Cache-Control':'no-store'}});
  async function baseline(env,userId) {
    const row = await env.AIHANGOUT_DB.prepare('SELECT u.username,l.profile_id FROM users u LEFT JOIN live_profile_links l ON l.user_id=u.id WHERE u.id=?').bind(userId).first();
    return {username:row.username,profileId:row.profile_id || null,key:row.profile_id || `initial:${row.username}`};
  }
  async function grant(request,env) {
    const token=request.headers.get('X-ProfilePays-Grant') || '';
    if(!/^[a-f0-9]{64}$/.test(token)) return null;
    return env.AIHANGOUT_DB.prepare('SELECT * FROM pp_grants WHERE token_hash=? AND revoked=0 AND expires_at>?').bind(await hash(token),Date.now()).first();
  }
  async function body(request,limit=2048) {
    const raw=await request.text();
    if(raw.length>limit) throw new Error('Invalid request');
    const value=safeJsonParse(raw);
    if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('Invalid request');
    return value;
  }
  const active = (a,normal,now) => a && !a.stopped && a.lease_until>now && (!a.ends_at || a.ends_at>now) && a.original_key===normal.key;
  router.post('/api/profilepays/grant',async(request,env)=>{
    if(!enabled(env)) return reply({error:'Test connector disabled'},503);
    const user=await authenticate(request,env);if(!user) return reply({error:'Authentication required'},401);
    const token=[...crypto.getRandomValues(new Uint8Array(32))].map(n=>n.toString(16).padStart(2,'0')).join('');
    // Reissuing invalidates the previous capability and any of its visible overlays.
    const id=crypto.randomUUID(),expires=Date.now()+31*86400000;
    await env.AIHANGOUT_DB.batch([
      env.AIHANGOUT_DB.prepare('UPDATE pp_assignments SET stopped=1 WHERE grant_id IN (SELECT id FROM pp_grants WHERE user_id=?)').bind(user.id),
      env.AIHANGOUT_DB.prepare('INSERT INTO pp_grants(id,user_id,token_hash,expires_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash,expires_at=excluded.expires_at,revoked=0').bind(id,user.id,await hash(token),expires)
    ]);
    return reply({token,expiresAt:expires,scope:'static-test-placement',normal:await baseline(env,user.id)});
  });
  router.delete('/api/profilepays/grant',async(request,env)=>{
    if(!enabled(env)) return reply({error:'Test connector disabled'},503);
    const user=await authenticate(request,env);if(!user) return reply({error:'Authentication required'},401);
    await env.AIHANGOUT_DB.prepare('UPDATE pp_grants SET revoked=1 WHERE user_id=?').bind(user.id).run();
    return reply({revoked:true});
  });
  router.get('/api/profilepays/connection',async(request,env)=>{
    if(!enabled(env)) return reply({error:'Test connector disabled'},503);
    const g=await grant(request,env);if(!g) return reply({error:'Grant expired or revoked'},401);
    return reply({subject:String(g.user_id),normal:await baseline(env,g.user_id),assets:[...assets],testCreditsOnly:true});
  });
  router.get('/api/users/by-username/:username/placement',async(request,env)=>{
    if(!enabled(env)) return reply({placement:null});
    const u=await env.AIHANGOUT_DB.prepare('SELECT id FROM users WHERE username=?').bind(request.params.username).first();
    if(!u) return reply({placement:null});
    const normal=await baseline(env,u.id),now=Date.now();
    const a=await env.AIHANGOUT_DB.prepare('SELECT a.* FROM pp_assignments a JOIN pp_grants g ON g.id=a.grant_id WHERE g.user_id=? AND g.revoked=0 AND g.expires_at>? AND a.stopped=0 AND a.lease_until>? ORDER BY a.applied_at DESC LIMIT 1').bind(u.id,now,now).first();
    return reply({normal,observedAt:now,placement:active(a,normal,now)?{id:a.id,assetKey:a.asset_key,assetUrl:a.asset_key.startsWith('sha256-')?`/api/profilepays/assets/${a.asset_key}`:`/profilepays/${a.asset_key}.png`,startsAt:a.starts_at,endsAt:a.ends_at,leaseUntil:a.lease_until,disclosure:'Sponsored test placement • test credits only'}:null});
  });
  router.get('/api/profilepays/assignments/:id',async(request,env)=>{
    if(!enabled(env)) return reply({error:'Test connector disabled'},503);
    const g=await grant(request,env);if(!g) return reply({error:'Grant expired or revoked'},401);
    const a=await env.AIHANGOUT_DB.prepare('SELECT * FROM pp_assignments WHERE id=? AND grant_id=?').bind(request.params.id,g.id).first();
    if(!a) return reply({error:'Assignment not found'},404);
    const normal=await baseline(env,g.user_id);
    return reply({id:a.id,startsAt:a.starts_at,endsAt:a.ends_at,leaseUntil:a.lease_until,stopped:!!a.stopped,originalMatches:normal.key===a.original_key,normal,observedAt:Date.now()});
  });
  router.put('/api/profilepays/assignments/:id',async(request,env)=>{
    if(!enabled(env)) return reply({error:'Test connector disabled'},503);
    const g=await grant(request,env);if(!g) return reply({error:'Grant expired or revoked'},401);
    try {
      const b=await body(request,97000),id=request.params.id,now=Date.now();
      const custom=typeof b.assetKey==='string'&&/^sha256-[a-f0-9]{64}$/.test(b.assetKey);
      if(!uuid(id)||(!assets.has(b.assetKey)&&!custom)||!Number.isInteger(b.durationSeconds)||b.durationSeconds<10||b.durationSeconds>86400||typeof b.originalKey!=='string'||Object.keys(b).some(k=>!['assetKey','durationSeconds','originalKey','png'].includes(k))) return reply({error:'Invalid assignment'},400);
      if(custom){
        if(typeof b.png!=='string'||b.png.length>95000||!/^[A-Za-z0-9+/]+={0,2}$/.test(b.png))return reply({error:'Invalid PNG'},400);
        const bytes=Uint8Array.from(atob(b.png),c=>c.charCodeAt(0));
        if(bytes.length<33||bytes.length>70000||[137,80,78,71,13,10,26,10].some((v,i)=>bytes[i]!==v)||new DataView(bytes.buffer).getUint32(16)!==128||new DataView(bytes.buffer).getUint32(20)!==128)return reply({error:'Invalid PNG'},400);
        const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');
        if(b.assetKey!=='sha256-'+digest)return reply({error:'Image hash mismatch'},400);
        const count=await env.AIHANGOUT_DB.prepare('SELECT COUNT(*) AS n FROM pp_creatives WHERE grant_id=?').bind(g.id).first();
        const prior=await env.AIHANGOUT_DB.prepare('SELECT asset_key FROM pp_creatives WHERE asset_key=?').bind(b.assetKey).first();
        if(!prior&&count.n>=100)return reply({error:'Creative limit reached'},409);
        await env.AIHANGOUT_DB.prepare('INSERT OR IGNORE INTO pp_creatives(asset_key,grant_id,png_base64) VALUES(?,?,?)').bind(b.assetKey,g.id,b.png).run();
      } else if(b.png!==undefined)return reply({error:'Unexpected image'},400);
      const normal=await baseline(env,g.user_id);if(b.originalKey!==normal.key) return reply({error:'Normal profile changed'},409);
      const existing=await env.AIHANGOUT_DB.prepare('SELECT * FROM pp_assignments WHERE id=?').bind(id).first();
      if(existing) {
        if(existing.grant_id!==g.id||existing.asset_key!==b.assetKey||existing.original_key!==b.originalKey||existing.duration_seconds!==b.durationSeconds) return reply({error:'Assignment conflict'},409);
        return reply({id,state:active(existing,normal,now)?'applied':'ended'});
      }
      // One SQL statement serializes competing claims for the same surface.
      const result=await env.AIHANGOUT_DB.prepare(`INSERT INTO pp_assignments(id,grant_id,asset_key,original_key,duration_seconds,applied_at,lease_until)
        SELECT ?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM pp_assignments WHERE grant_id=? AND stopped=0 AND lease_until>? AND (ends_at IS NULL OR ends_at>?))`)
        .bind(id,g.id,b.assetKey,b.originalKey,b.durationSeconds,now,now+30000,g.id,now,now).run();
      return reply(result.meta.changes?{id,state:'applied'}:{error:'Surface occupied'},result.meta.changes?200:409);
    }catch{return reply({error:'Invalid assignment'},400);}
  });
  router.post('/api/profilepays/assignments/:id/renew',async(request,env)=>{
    if(!enabled(env)) return reply({error:'Test connector disabled'},503);
    const g=await grant(request,env);if(!g) return reply({error:'Grant expired or revoked'},401);
    const now=Date.now(),normal=await baseline(env,g.user_id);
    // First renewal confirms start after independent readback. Replays never move the start/end.
    const result=await env.AIHANGOUT_DB.prepare(`UPDATE pp_assignments SET starts_at=COALESCE(starts_at,?),ends_at=COALESCE(ends_at,?+duration_seconds*1000),lease_until=MIN(COALESCE(ends_at,?+duration_seconds*1000),?+120000)
      WHERE id=? AND grant_id=? AND stopped=0 AND lease_until>? AND (ends_at IS NULL OR ends_at>?) AND original_key=?`)
      .bind(now,now,now,now,request.params.id,g.id,now,now,normal.key).run();
    if(!result.meta.changes) return reply({error:'Assignment ended or normal profile changed'},409);
    const a=await env.AIHANGOUT_DB.prepare('SELECT starts_at,ends_at FROM pp_assignments WHERE id=? AND grant_id=?').bind(request.params.id,g.id).first();
    return reply({startsAt:a.starts_at,endsAt:a.ends_at});
  });
  router.delete('/api/profilepays/assignments/:id',async(request,env)=>{
    if(!enabled(env)) return reply({error:'Test connector disabled'},503);
    const g=await grant(request,env);if(!g) return reply({error:'Grant expired or revoked'},401);
    await env.AIHANGOUT_DB.prepare('UPDATE pp_assignments SET stopped=1 WHERE id=? AND grant_id=?').bind(request.params.id,g.id).run();
    return reply({removed:true,normal:await baseline(env,g.user_id)});
  });
  router.get('/api/profilepays/assets/:key',async(request,env)=>{
    if(!enabled(env)||!/^sha256-[a-f0-9]{64}$/.test(request.params.key))return reply({error:'Image unavailable'},404);
    const a=await env.AIHANGOUT_DB.prepare('SELECT png_base64 FROM pp_creatives WHERE asset_key=?').bind(request.params.key).first();
    if(!a)return reply({error:'Image unavailable'},404);
    return new Response(Uint8Array.from(atob(a.png_base64),c=>c.charCodeAt(0)),{headers:{'Content-Type':'image/png','Cache-Control':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'}});
  });
}
