// Proves possession of a P-256 private key, not hardware or application identity.
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
function decode(value, maxBytes) {
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid encoding');
  const raw = atob(value);
  if (btoa(raw) !== value || raw.length > maxBytes) throw new Error('Invalid encoding');
  return Uint8Array.from(raw, ch => ch.charCodeAt(0));
}

export function installMobileEnrollment(router, { authenticate, safeJsonParse, sanitizeContent, jsonResponse, checkRateLimit, rateLimitResponse, consumeArmedMobileFault }) {
  const failure = (error, status = 400) => jsonResponse({ success: false, error }, { status });
  const policy = env => typeof env.MOBILE_APP_ID === 'string' && /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(env.MOBILE_APP_ID)
    && typeof env.MOBILE_APP_CERT_SHA256 === 'string' && /^[a-f0-9]{64}$/.test(env.MOBILE_APP_CERT_SHA256);

  router.post('/api/mobile/devices/challenge', async (request, env) => {
    try {
      const user = await authenticate(request, env);
      if (!user) return failure('Authentication required', 401);
      const rl = await checkRateLimit(env.AIHANGOUT_KV, request.headers.get('CF-Connecting-IP') || 'unknown', user.id, 'mobile_enroll');
      if (rl.limited) return rateLimitResponse(rl);
      if (!policy(env)) return failure('Enrollment build policy is not configured', 503);
      const body = safeJsonParse(await request.text());
      const agentName = typeof body?.agentName === 'string' ? body.agentName.trim() : '';
      if (!agentName || agentName.length > 100 || sanitizeContent(agentName) !== agentName) return failure('Invalid agentName');
      if (body.packageName !== env.MOBILE_APP_ID || body.signingCertSha256 !== env.MOBILE_APP_CERT_SHA256) return failure('Unrecognized build claim');
      const keyBytes = decode(body.publicKeySpki, 256);
      await crypto.subtle.importKey('spki', keyBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const challengeId = crypto.randomUUID();
      const nonce = encode(crypto.getRandomValues(new Uint8Array(32)));
      const expiresAt = Date.now() + 300000;
      const signingPayload = JSON.stringify({ domain: 'aihangout.mobile.enrollment.v1', challengeId,
        nonce, ownerUserId: String(user.id), agentName, publicKeySpki: body.publicKeySpki,
        packageName: body.packageName, signingCertSha256: body.signingCertSha256, expiresAt });
      await env.AIHANGOUT_DB.prepare(`INSERT INTO mobile_enrollment_challenges
        (challenge_id, owner_user_id, agent_name, nonce, signing_payload, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(challengeId, user.id, agentName, nonce, signingPayload, expiresAt).run();
      return jsonResponse({ success: true, challengeId, nonce, expiresAt, signingPayload,
        algorithm: 'ECDSA-P256-SHA256', signatureEncoding: 'base64-p1363', assurance: 'key_possession_only' });
    } catch (error) {
      if (error?.name === 'DataError' || error?.name === 'InvalidCharacterError' || /Invalid encoding/.test(error?.message || '')) return failure('Invalid public key encoding');
      return failure('Enrollment challenge unavailable', 503);
    }
  });

  router.post('/api/mobile/devices/enroll', async (request, env) => {
    try {
      const user = await authenticate(request, env);
      if (!user) return failure('Authentication required', 401);
      const rl = await checkRateLimit(env.AIHANGOUT_KV, request.headers.get('CF-Connecting-IP') || 'unknown', user.id, 'mobile_enroll');
      if (rl.limited) return rateLimitResponse(rl);
      if (!policy(env)) return failure('Enrollment build policy is not configured', 503);
      const body = safeJsonParse(await request.text());
      if (typeof body?.challengeId !== 'string' || body.challengeId.length > 64) return failure('Signed challenge required');
      const challenge = await env.AIHANGOUT_DB.prepare(`SELECT * FROM mobile_enrollment_challenges
        WHERE challenge_id = ? AND owner_user_id = ? AND consumed_at IS NULL AND expires_at > ?`)
        .bind(body.challengeId, user.id, Date.now()).first();
      if (!challenge) return failure('Challenge unavailable', 409);
      const signed = safeJsonParse(challenge.signing_payload);
      if (body.agentName !== signed.agentName || body.publicKeySpki !== signed.publicKeySpki ||
          body.packageName !== signed.packageName || body.signingCertSha256 !== signed.signingCertSha256 ||
          signed.packageName !== env.MOBILE_APP_ID || signed.signingCertSha256 !== env.MOBILE_APP_CERT_SHA256) return failure('Challenge binding mismatch');
      const signature = decode(body.signature, 64);
      if (signature.length !== 64) return failure('Expected 64-byte P1363 signature');
      const key = await crypto.subtle.importKey('spki', decode(signed.publicKeySpki, 256),
        { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature,
        new TextEncoder().encode(challenge.signing_payload))) return failure('Invalid signature', 403);
      const deviceId = crypto.randomUUID();
      const now = Date.now();
      // INSERT eligibility and consumption are in the same D1 transaction. A
      // concurrent request cannot consume or enroll the same challenge twice.
      const result = await env.AIHANGOUT_DB.batch([
        env.AIHANGOUT_DB.prepare(`INSERT INTO mobile_devices
          (device_id, owner_user_id, agent_name, device_public_key, enrollment_challenge_id,
           public_key_alg, public_key_spki, key_security_level, signing_cert_sha256, package_name, last_challenge_verified_at)
          SELECT ?, ?, ?, ?, challenge_id, 'ES256', ?, 'unknown', ?, ?, CURRENT_TIMESTAMP
          FROM mobile_enrollment_challenges WHERE challenge_id = ? AND owner_user_id = ?
          AND consumed_at IS NULL AND expires_at > ?`)
          .bind(deviceId, user.id, signed.agentName, signed.publicKeySpki, signed.publicKeySpki,
            signed.signingCertSha256, signed.packageName, body.challengeId, user.id, now),
        env.AIHANGOUT_DB.prepare(`UPDATE mobile_enrollment_challenges SET consumed_at = ?
          WHERE challenge_id = ? AND consumed_at IS NULL AND EXISTS
          (SELECT 1 FROM mobile_devices WHERE device_id = ? AND enrollment_challenge_id = ?)`)
          .bind(now, body.challengeId, deviceId, body.challengeId)
      ]);
      if (result[0].meta.changes !== 1) return failure('Challenge unavailable', 409);
      // Local/test-only ambiguous-POST fault: the device row above is already
      // committed; the response is deliberately lost. Inert unless armed.
      const injectedFault = consumeArmedMobileFault ? await consumeArmedMobileFault(env, 'enroll_lost_response') : null;
      if (injectedFault) return injectedFault;
      return jsonResponse({ success: true, deviceId, agentName: signed.agentName, status: 'active',
        assurance: 'key_possession_only', keySecurityLevel: 'unknown' });
    } catch (error) {
      if (/UNIQUE constraint failed/.test(error?.message || '')) return failure('Enrollment conflicts with an existing device', 409);
      if (error?.name === 'DataError' || error?.name === 'InvalidCharacterError' || /Invalid encoding/.test(error?.message || '')) return failure('Invalid cryptographic encoding');
      return failure('Enrollment unavailable', 503);
    }
  });
}
