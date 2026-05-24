import { HEADERS_METADATA } from '@nestjs/common/constants';
import { MarketSignalController } from './market-signal.controller';
import { MarketSuppressionController } from './market-suppression.controller';

describe('Market signal and suppression cache headers', () => {
  it('marks signal ingestion as no-store', () => {
    const headers = Reflect.getMetadata(
      HEADERS_METADATA,
      MarketSignalController.prototype.ingestSignalBatch,
    );

    expect(headers).toContainEqual({
      name: 'Cache-Control',
      value: 'no-store',
    });
  });

  it('marks suppression endpoints as private no-store', () => {
    const methods = [
      MarketSuppressionController.prototype.createSuppression,
      MarketSuppressionController.prototype.listSuppressions,
      MarketSuppressionController.prototype.deleteSuppression,
    ];

    for (const method of methods) {
      expect(Reflect.getMetadata(HEADERS_METADATA, method)).toContainEqual({
        name: 'Cache-Control',
        value: 'private, no-store',
      });
    }
  });
});
