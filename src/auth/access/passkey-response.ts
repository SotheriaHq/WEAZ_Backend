/** Transport bounds only. The WebAuthn verifier still validates signatures, RP, origin and UV. */
export function boundedPasskeyResponse(value: unknown, kind: 'registration' | 'authentication'): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  const base64 = (item: unknown, maximum: number) => typeof item === 'string' && item.length > 0 &&
    item.length <= maximum && /^[A-Za-z0-9_-]+$/.test(item) && Buffer.from(item, 'base64url').toString('base64url') === item;
  if (credential.type !== 'public-key' || !base64(credential.id, 1400) || credential.rawId !== credential.id ||
    !credential.response || typeof credential.response !== 'object' || Array.isArray(credential.response)) return false;
  const response = credential.response as Record<string, unknown>;
  if (!base64(response.clientDataJSON, 16384)) return false;
  if (kind === 'registration' ? !base64(response.attestationObject, 98304) :
    !base64(response.authenticatorData, 16384) || !base64(response.signature, 8192)) return false;
  try { return Buffer.byteLength(JSON.stringify(value), 'utf8') <= 131072; }
  catch { return false; }
}
