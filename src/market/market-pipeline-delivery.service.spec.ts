import { MarketPipelineDeliveryService } from './market-pipeline-delivery.service';
import { MarketPipelineService } from './pipeline/market-pipeline.service';
import { PrismaService } from '../prisma/prisma.service';
import { writePipelineExposures } from './pipeline/market-pipeline.delivery';

jest.mock('./pipeline/market-pipeline.delivery', () => ({
  writePipelineExposures: jest.fn().mockResolvedValue(1),
}));

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
  beforeEach(() => jest.clearAllMocks());
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
