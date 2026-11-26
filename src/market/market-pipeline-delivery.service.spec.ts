import {
  MARKET_EXPOSURE_MEMO_LIMIT,
  MarketPipelineDeliveryService,
} from './market-pipeline-delivery.service';
import { MarketPipelineService } from './pipeline/market-pipeline.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  pipelineExposureKeys,
  writePipelineExposures,
} from './pipeline/market-pipeline.delivery';

jest.mock('./pipeline/market-pipeline.delivery', () => ({
  writePipelineExposures: jest.fn().mockResolvedValue(1),
  pipelineExposureKeys: jest.fn(),
}));
const exposureKeys = pipelineExposureKeys as jest.Mock;
let keySequence = 0;
/** Each page gets its own rows unless a test pins them. */
function freshKeys() {
  keySequence++;
  return {
    keys: [`2026-11-24T12:00:00.000Z|fresh-drops|${keySequence}`],
    expiresAt: Date.now() + 3_600_000,
  };
}

describe('bounded server exposure delivery', () => {
  const input = { viewer: {}, limit: 1 };
  function fixture() {
    const prepared = {
      public: { sections: [{ key: 'fresh-drops' }] },
      exposureReceipt: {},
      context: { deadline: performance.now() + 550 },
    };
    const preparePage = jest.fn().mockResolvedValue(prepared);
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const transaction = jest.fn(
      async (fn, _options?: { timeout: number; maxWait: number }) => fn(tx),
    );
    const service = new MarketPipelineDeliveryService(
      { preparePage } as unknown as MarketPipelineService,
      { $transaction: transaction } as unknown as PrismaService,
    );
    return { service, prepared, preparePage, tx, transaction };
  }
  beforeEach(() => {
    jest.clearAllMocks();
    exposureKeys.mockImplementation(freshKeys);
  });
  it('skips the write transaction when every row was already committed this epoch', async () => {
    const { service, transaction } = fixture();
    const pinned = freshKeys();
    exposureKeys.mockReturnValue(pinned);
    await service.page(input);
    await service.page(input);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('writes again once a row is new, or after the epoch ends', async () => {
    const { service, transaction } = fixture();
    const pinned = freshKeys();
    exposureKeys.mockReturnValue(pinned);
    await service.page(input);
    exposureKeys.mockReturnValue({
      keys: [...pinned.keys, 'another|row|1'],
      expiresAt: pinned.expiresAt,
    });
    await service.page(input);
    expect(transaction).toHaveBeenCalledTimes(2);
    const expired = { keys: ['expired|row|1'], expiresAt: Date.now() - 1 };
    exposureKeys.mockReturnValue(expired);
    await service.page(input);
    await service.page(input);
    expect(transaction).toHaveBeenCalledTimes(4);
  });
  it('never remembers rows whose transaction rolled back', async () => {
    const { service, transaction, prepared } = fixture();
    const pinned = freshKeys();
    exposureKeys.mockReturnValue(pinned);
    transaction.mockRejectedValueOnce(new Error('rollback'));
    await expect(service.page(input)).resolves.toBe(prepared.public);
    await service.page(input);
    expect(transaction).toHaveBeenCalledTimes(2);
    await service.page(input);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
  it('keeps the committed-row memory bounded', async () => {
    const { service } = fixture();
    exposureKeys.mockReturnValue({
      keys: Array.from(
        { length: MARKET_EXPOSURE_MEMO_LIMIT + 50 },
        (_, n) => `bound|row|${n}`,
      ),
      expiresAt: Date.now() + 3_600_000,
    });
    await service.page(input);
    expect(
      (service as unknown as { written: Map<string, number> }).written.size,
    ).toBe(MARKET_EXPOSURE_MEMO_LIMIT);
  });
  it('returns the public page without writing when the receipt is invalid', async () => {
    const { service, transaction, prepared } = fixture();
    exposureKeys.mockImplementation(() => {
      throw new RangeError('Invalid exposure receipt');
    });
    await expect(service.page(input)).resolves.toBe(prepared.public);
    expect(transaction).not.toHaveBeenCalled();
  });
  it('preserves an internal section limit when the HTTP alias is absent', async () => {
    const { service, preparePage } = fixture();
    await service.page({ viewer: {}, sectionLimit: 2 });
    expect(preparePage).toHaveBeenCalledWith({ viewer: {}, sectionLimit: 2 });
  });
  it('uses the already-sliced server receipt outside read capture and returns public JSON only', async () => {
    const { service, prepared, preparePage, tx, transaction } = fixture();
    expect(await service.page(input)).toBe(prepared.public);
    expect(preparePage).toHaveBeenCalledWith({ ...input, sectionLimit: 1 });
    expect(writePipelineExposures).toHaveBeenCalledWith(
      tx,
      prepared.exposureReceipt,
    );
    expect(transaction.mock.calls[0][1]!.timeout).toBeLessThanOrEqual(200);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it('keeps write failures out of the public response and skips writes after cancellation', async () => {
    const { service, transaction, prepared } = fixture();
    transaction.mockRejectedValueOnce(new Error('private database detail'));
    await expect(service.page(input)).resolves.toBe(prepared.public);
    const abort = new AbortController();
    abort.abort();
    await expect(
      service.page({ ...input, signal: abort.signal }),
    ).resolves.toBe(prepared.public);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('retains admission until real writes settle, with at most four concurrent writes', async () => {
    const { service, transaction } = fixture();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    transaction.mockImplementation(async () => pending);
    const first = Array.from({ length: 4 }, () => service.page(input));
    await Promise.resolve();
    await Promise.resolve();
    await service.page(input);
    expect(transaction).toHaveBeenCalledTimes(4);
    release();
    await Promise.all(first);
  });
  it('rechecks the absolute deadline after transaction acquisition and skips expired writes', async () => {
    const { service, transaction, prepared, tx } = fixture();
    transaction.mockImplementation(async (fn) => {
      prepared.context.deadline = performance.now() - 1;
      return fn(tx);
    });
    await expect(service.page(input)).resolves.toBe(prepared.public);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(writePipelineExposures).not.toHaveBeenCalled();
  });
  it('does not write a receipt if cancellation arrives during setup', async () => {
    const { service, tx, prepared } = fixture();
    const abort = new AbortController();
    tx.$queryRaw.mockImplementationOnce(async () => {
      abort.abort();
      return [];
    });
    await expect(
      service.page({ ...input, signal: abort.signal }),
    ).resolves.toBe(prepared.public);
    expect(writePipelineExposures).not.toHaveBeenCalled();
  });
});
