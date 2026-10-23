import { PayoutService } from './payout.service';

describe('Payout source reservation', () => {
  const entry = (id: string, orderId: string, amount = 10, description = 'shipment release') => ({
    id, amount, payoutSourceAllocations: [],
    transaction: { referenceType: 'ORDER', referenceId: orderId, description },
  });
  const setup = (entries: ReturnType<typeof entry>[]) => {
    const service = Object.create(PayoutService.prototype) as any;
    const tx = {
      ledgerEntry: { findMany: jest.fn().mockResolvedValue(entries) },
      escrowHold: { findMany: jest.fn(async ({ where }: any) => where.orderId.in.map((orderId: string) => ({
        id: `hold-${orderId}`, orderId, firstReleasedAt: null,
      }))) },
      payoutLedgerSourceAllocation: { createMany: jest.fn().mockResolvedValue({ count: entries.length }) },
    };
    return { service, tx };
  };

  it('preserves oldest-first partial reservation and reads each selected order once', async () => {
    const entries = [entry('first', 'same'), entry('second', 'same', 10, 'final release'), entry('unused', 'not-needed')];
    const { service, tx } = setup(entries);
    await service.reserveLedgerSources(tx, 'brand', 'payout', 12, 'NGN');
    expect(tx.escrowHold.findMany).toHaveBeenCalledTimes(1);
    expect(tx.escrowHold.findMany.mock.calls[0][0].where.orderId.in).toEqual(['same']);
    const rows = tx.payoutLedgerSourceAllocation.createMany.mock.calls[0][0].data;
    expect(rows.map((row: any) => ({ id: row.ledgerEntryId, amount: Number(row.amount), hold: row.escrowHoldId, stage: row.releaseStage }))).toEqual([
      { id: 'first', amount: 10, hold: 'hold-same', stage: 'SHIPMENT_PORTION' },
      { id: 'second', amount: 2, hold: 'hold-same', stage: 'FINAL_PORTION' },
    ]);
  });

  it('bounds each metadata query to500 selected order IDs', async () => {
    const { service, tx } = setup(Array.from({ length: 501 }, (_, i) => entry(`credit-${i}`, `order-${i}`, 1)));
    await service.reserveLedgerSources(tx, 'brand', 'payout', 501, 'NGN');
    expect(tx.escrowHold.findMany.mock.calls.map(([query]) => query.where.orderId.in.length)).toEqual([500, 1]);
    expect(tx.payoutLedgerSourceAllocation.createMany.mock.calls[0][0].data).toHaveLength(501);
  });

  it('does not query holds or write allocations when the reservable amount is insufficient', async () => {
    const { service, tx } = setup([entry('credit', 'order', 1)]);
    await expect(service.reserveLedgerSources(tx, 'brand', 'payout', 2, 'NGN')).rejects.toThrow('Exact payout source reservation failed');
    expect(tx.escrowHold.findMany).not.toHaveBeenCalled();
    expect(tx.payoutLedgerSourceAllocation.createMany).not.toHaveBeenCalled();
  });

  it('preserves non-order and missing-source metadata behavior', async () => {
    const credit = entry('credit', 'order');
    credit.transaction.referenceType = 'CUSTOM_ORDER';
    const { service, tx } = setup([credit]);
    await service.reserveLedgerSources(tx, 'brand', 'payout', 5, 'NGN');
    expect(tx.escrowHold.findMany).not.toHaveBeenCalled();
    expect(tx.payoutLedgerSourceAllocation.createMany.mock.calls[0][0].data[0]).toMatchObject({ escrowHoldId: null, releaseStage: null });
    expect(service.resolveEscrowSourceForLedgerEntry({ referenceType: 'ORDER', referenceId: 'missing' }, new Map())).toEqual({ escrowHoldId: null, releaseStage: null });
  });
});
