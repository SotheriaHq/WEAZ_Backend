import { boundedPasskeyResponse } from './passkey-response';
const encoded = Buffer.from('fixture').toString('base64url');
const credential = { id: encoded, rawId: encoded, type: 'public-key', clientExtensionResults: {},
  response: { clientDataJSON: encoded, attestationObject: encoded, authenticatorData: encoded, signature: encoded } };
describe('bounded WebAuthn input', () => {
  it('passes correctly bounded transport envelopes to the actual cryptographic verifier', () => {
    expect(boundedPasskeyResponse(credential, 'registration')).toBe(true);
    expect(boundedPasskeyResponse(credential, 'authentication')).toBe(true);
  });
  it.each([null, [], {}, { ...credential, type: 'password' }, { ...credential, rawId: 'different' },
    { ...credential, id: '***' }, { ...credential, response: null }, { ...credential, response: { clientDataJSON: encoded } },
    { ...credential, response: { ...credential.response, attestationObject: 'A'.repeat(98308) } },
    { ...credential, clientExtensionResults: { unbounded: 'a'.repeat(131072) } }])('rejects malformed or oversized registration input: %#', value => {
      expect(boundedPasskeyResponse(value, 'registration')).toBe(false);
    });
  it('rejects cyclic internal objects and malformed authentication components', () => {
    const circular = { ...credential, loop: {} }; circular.loop = circular;
    expect(boundedPasskeyResponse(circular, 'registration')).toBe(false);
    expect(boundedPasskeyResponse({ ...credential, response: { ...credential.response, signature: '***' } }, 'authentication')).toBe(false);
  });
});
