import { SubscriptionPaystackService } from './subscription-paystack.service';
describe('subscription payment simulation boundary', () => {
  const original = process.env.PAYMENTS_MODE;
  afterEach(() => { if (original === undefined) delete process.env.PAYMENTS_MODE; else process.env.PAYMENTS_MODE = original; jest.restoreAllMocks(); });
  it('never contacts a provider for a recurring charge in simulation mode', async () => {
    process.env.PAYMENTS_MODE = 'mock';
    const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Provider must not be contacted'));
    await expect(new SubscriptionPaystackService().charge('fixture', 10000, 'fixture-authorization', 'fixture@example.invalid')).rejects.toThrow('disabled in simulated payment mode');
    expect(fetch).not.toHaveBeenCalled();
  });
});
