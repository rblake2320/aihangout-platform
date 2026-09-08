export const b64 = data => btoa(String.fromCharCode(...new Uint8Array(data)));
export async function enrollmentProof(api, user, agentName) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const claims = { agentName, publicKeySpki: b64(await crypto.subtle.exportKey('spki', keys.publicKey)),
    packageName: 'ai.hangout.test', signingCertSha256: 'a'.repeat(64) };
  const response = await api('/api/mobile/devices/challenge', { method: 'POST', token: user.token, body: claims });
  if (response.status !== 200) throw new Error(JSON.stringify(response));
  const signature = b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey,
    new TextEncoder().encode(response.json.signingPayload)));
  return { keys, challenge: response.json, body: { ...claims, challengeId: response.json.challengeId, signature } };
}
