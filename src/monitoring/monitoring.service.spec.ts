import { MonitoringService } from './monitoring.service';

describe('MonitoringService', () => {
  it('redacts secrets and private payload fields before buffering alerts', () => {
    const service = new MonitoringService();

    const alert = service.emitAlert({
      category: 'PAYMENT',
      severity: 'critical',
      event: 'payment_mismatch',
      message: 'Payment mismatch detected',
      metadata: {
        token: 'jwt-token',
        cookie: 'session=raw',
        password: 'RawPassword123',
        webhookSignature: 'paystack-signature',
        paystackSecret: 'sk_live_sensitive',
        s3Key: 'PRIVATE/user_1/file.png',
        signedUrl:
          'https://bucket.s3.eu-north-1.amazonaws.com/key?X-Amz-Signature=raw',
        payment: {
          cardNumber: '4084084084084081',
          cvv: '123',
          paymentMetadata: { email: 'buyer@example.com' },
        },
      },
    });

    expect(alert.metadata).toEqual({
      token: '[REDACTED]',
      cookie: '[REDACTED]',
      password: '[REDACTED]',
      webhookSignature: '[REDACTED]',
      paystackSecret: '[REDACTED]',
      s3Key: '[REDACTED]',
      signedUrl: '[REDACTED]',
      payment: {
        cardNumber: '[REDACTED]',
        cvv: '[REDACTED]',
        paymentMetadata: { email: '[REDACTED]' },
      },
    });
    expect(JSON.stringify(alert)).not.toContain('sk_live_sensitive');
    expect(JSON.stringify(alert)).not.toContain('X-Amz-Signature');
  });

  it('buffers metric-like events for local tests without external delivery', () => {
    const service = new MonitoringService();

    service.emitMetric('market_signal_duplicate_replay', { count: 2 }, 'RANKING');

    expect(service.getBufferedAlerts()).toEqual([
      expect.objectContaining({
        category: 'RANKING',
        severity: 'info',
        event: 'market_signal_duplicate_replay',
        metadata: { count: 2 },
      }),
    ]);
  });
});
