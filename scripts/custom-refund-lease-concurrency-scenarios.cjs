const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { CustomOrderQueueRefundsService } = require('../src/custom-orders/queue/custom-order-queue-refunds.service');
const { loadQueueRefundContexts } = require('../src/custom-orders/queue/queue-refund-query');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const gate = override => ({ arrived: deferred(), release: deferred(), override });

module.exports = async function scenarios({ prisma, ledger, balance, provider, simulator, buyer, ownerId, brandId, paid, refunds, request, onlyStandard }) {
  const cases = [];
  const running = [], gates = [], releases = [];
  const watch = promise => { promise.catch(() => {}); running.push(promise); return promise; };
  const makeGate = override => { const value = gate(override); gates.push(value); return value; };
  try {
  const source = await prisma.collection.create({ data: { id: randomUUID(), ownerId, title: 'Custom refund lease fixture' } });
  const basis = await prisma.customFabricRuleBasis.create({ data: { label: 'Custom refund lease fixture', brandId } });
  const config = await prisma.customOrderConfiguration.create({ data: { brandId, sourceType: 'DESIGN', sourceId: source.id, title: 'Custom refund lease fixture', fabricRuleBasisId: basis.id, baseProductionCharge: 100, fabricCostPerYard: 0, productionLeadDays: 1, deliveryMinDays: 1, deliveryMaxDays: 2, deliveryScope: 'LOCAL', revisionPolicy: 'Fixture', returnPolicy: 'Fixture', defectPolicy: 'Fixture', fabricSourcingMode: 'BRAND_SOURCED' } });
  const version = await prisma.customOrderConfigurationVersion.create({ data: { configurationId: config.id, version: 1, snapshotJson: {}, createdById: ownerId } });
  const service = () => new CustomOrderQueueRefundsService(prisma, ledger, provider);
  const read = async id => (await loadQueueRefundContexts(prisma, { id }))[0];
  const only = async id => {
    await prisma.customOrderQueueRefund.updateMany({ where: { id: { not: id }, status: { in: ['REQUESTED','FAILED','PROCESSING'] } }, data: { nextAttemptAt: new Date(Date.now()+86_400_000) } });
    await prisma.customOrderQueueRefund.update({ where: { id }, data: { nextAttemptAt: new Date(0) } });
  };
  const settled = id => prisma.ledgerTransaction.count({ where: { referenceType: 'CustomOrderQueueRefund', referenceId: id, type: 'REFUND_ISSUED' } });
  let sequence = 90_000;
  async function fixture({ start = true, refundAmount=90, quote={}, mode='test', currency='NGN', settlementAmount=100 } = {}) {
    const reference = `custom-refund-owner-${randomUUID()}`, transactionId = ++sequence;
    const order = await prisma.customOrder.create({ data: { brandId, buyerId: buyer, sourceType: 'DESIGN', sourceId: source.id, sourceTitleSnapshot: 'Refund fixture', configurationId: config.id, configurationVersionId: version.id, status: 'CANCELLED_BY_BUYER_PRE_ACCEPTANCE', lane: 'TERMINAL', cancelledAt: new Date(), paymentStatus: 'PAID', baseProductionChargeSnapshot: 100, fabricCostPerYardSnapshot: 0, computedYards: 0, internalPriceBreakdownJson: {}, buyerPriceSummaryJson: { grandTotal: 100 }, measurementSnapshotJson: {}, measurementConfirmedAt: new Date(), productionLeadDaysSnapshot: 1, deliveryMinDaysSnapshot: 1, deliveryMaxDaysSnapshot: 2, paymentReference: reference } });
    const capture = await prisma.paymentAttempt.create({ data: { buyerId: buyer, provider: 'PAYSTACK', providerMode: mode, paymentMethod: 'PAYSTACK', status: 'PAID', reference, providerTransactionId: String(transactionId), amount: 100, currency, settlementAmount, settlementCurrency: 'NGN', subjectType: 'CUSTOM_ORDER' } });
    simulator.state.transactions.set(reference, { id: transactionId, amount: 10000, currency });
    const refund = await prisma.customOrderQueueRefund.create({ data: { customOrderId: order.id, paymentAttemptId: capture.id, amount: refundAmount, currency, breakdownJson: { captureAmount: 100, refundAmount, vatAmount:100-refundAmount, garmentCharge: 0, jumpCharge: 0, currency, refundKind: 'WAITING_CANCELLED', settlement: { status: 'RECORDED', currency: 'NGN', amount: currency === 'NGN' ? refundAmount : refundAmount * (settlementAmount/100) },...quote }, nextAttemptAt: new Date(0) } });
    await only(refund.id);
    if (start) { assert.equal(await service().processOne(refund.id), true); assert.equal((await read(refund.id)).status, 'PROCESSING'); }
    return { id: refund.id, order, capture, reference, read: () => read(refund.id) };
  }
  async function finish(item) {
    const beforeOrder=await prisma.customOrder.findUniqueOrThrow({where:{id:item.order.id}});
    const row = await item.read(); simulator.state.refunds.get(row.providerRefundId).status = 'processed';
    await only(item.id); await service().processPending();
    assert.equal((await item.read()).status, 'SETTLED'); assert.equal(await settled(item.id), 1);
    const afterOrder=await prisma.customOrder.findUniqueOrThrow({where:{id:item.order.id}});
    assert.equal(afterOrder.status,'CLOSED');assert.equal(afterOrder.paymentStatus,'REFUNDED');
    assert.equal(afterOrder.orderRevision,beforeOrder.orderRevision+1);
    assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({where:{id:row.paymentAttemptId}})).status,'PAID');
    await service().handleWebhook('PAYSTACK',{event:'refund.processed',data:{id:row.providerRefundId}});
    assert.equal((await prisma.customOrder.findUniqueOrThrow({where:{id:item.order.id}})).orderRevision,afterOrder.orderRevision);
  }
  const foreign = await fixture({currency:'USD',settlementAmount:136120});
  const foreignRow = await foreign.read(), foreignProvider = simulator.state.refunds.get(foreignRow.providerRefundId);
  assert.equal(foreignProvider.currency,'USD'); assert.equal(foreignProvider.amount,9000);
  assert.equal(foreignRow.currency,'USD'); assert.equal(foreignRow.breakdownJson.settlement.currency,'NGN');
  assert.equal(foreignRow.breakdownJson.settlement.amount,122508);
  cases.push('a custom refund uses its USD90 charged amount at the provider, retains its separate original-rate NGN122508 snapshot and preserves the current operation owner');

  for (const variant of ['error','pending','processed','mismatch']) {
    const item = await fixture();
    const oldGate = makeGate(variant === 'processed' ? { status: 'processed' } : variant === 'mismatch' ? { amount: 1 } : {});
    if (variant === 'error') oldGate.status = 503;
    const newGate = makeGate({ status: 'pending' });
    const initial = await item.read();
    simulator.state.lookupGates.set(initial.providerRefundId, [oldGate, newGate]);
    const oldPoll = watch(service().poll(initial));
    await oldGate.arrived.promise;
    await prisma.$executeRaw`UPDATE "CustomOrderQueueRefund" SET "lockedAt"=(clock_timestamp() AT TIME ZONE 'UTC')-INTERVAL '11 minutes' WHERE id=${item.id}::uuid`;
    const currentPoll = watch(service().poll(initial));
    await newGate.arrived.promise;
    const current = await item.read(); assert(current.leaseToken);
    oldGate.release.resolve(); await oldPoll;
    const after = await item.read();
    assert.equal(after.leaseToken, current.leaseToken); assert.equal(after.lockedAt.getTime(), current.lockedAt.getTime());
    assert.equal(after.status, 'PROCESSING'); assert.equal(after.lastError, null); assert.equal(await settled(item.id), 0);
    newGate.release.resolve(); await currentPoll;
    await finish(item);
    cases.push(`custom refund late ${variant} lookup cannot clear a replacement owner, change attention or settle money; the active owner finishes once`);
  }
  const contested = await fixture();
  const held = deferred(), release = deferred();
  releases.push(release);
  const blocker = watch(prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "CustomOrder" WHERE id=${contested.order.id}::uuid FOR UPDATE`;
    held.resolve(); await release.promise;
  }, { timeout: 20_000 }));
  await held.promise;
  simulator.state.refunds.get((await contested.read()).providerRefundId).status = 'processed';
  const old = watch(service().poll(await contested.read()));
  let blocked = false;
  for (let attempt=0;attempt<100;attempt++) {
    const rows=await prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
    if(rows[0].n>0){blocked=true;break;} await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert(blocked, 'Actual custom-order lock wait must be observed');
  await prisma.$executeRaw`UPDATE "CustomOrderQueueRefund" SET "lockedAt"=(clock_timestamp() AT TIME ZONE 'UTC')-INTERVAL '11 minutes' WHERE id=${contested.id}::uuid`;
  const replacementGate=makeGate({status:'pending'});
  simulator.state.lookupGates.set((await contested.read()).providerRefundId,[replacementGate]);
  const replacement=watch(service().poll(await contested.read())); await replacementGate.arrived.promise;
  release.resolve(); await blocker; await old;
  assert.equal(await settled(contested.id),0);
  replacementGate.release.resolve();await replacement;await finish(contested);
  cases.push('a real custom-order lock wait rechecks database ownership before money settles, preserving a newer pending lookup');

  const race = await fixture({ start:false });
  const beforePosts = simulator.state.posts.get(race.reference)||0;
  await Promise.all(Array.from({length:32},()=>service().processPending()));
  assert.equal((simulator.state.posts.get(race.reference)||0)-beforePosts,1);
  assert.equal((await race.read()).attempts,1);await finish(race);
  cases.push('32 actual custom-refund sweeps share one submission and one reservation, preserving four-wide worker processing');

  const unknown = await fixture({ start:false });
  const owner = randomUUID(); assert(await service().claim(await unknown.read(),owner));
  await prisma.$executeRaw`UPDATE "CustomOrderQueueRefund" SET "lockedAt"=(clock_timestamp() AT TIME ZONE 'UTC')-INTERVAL '11 minutes' WHERE id=${unknown.id}::uuid`;
  await service().processPending();
  assert.equal((await unknown.read()).status,'NEEDS_ATTENTION');assert.equal(simulator.state.posts.get(unknown.reference)||0,0);
  cases.push('an expired custom submission with no known provider result goes to reconciliation and is never posted again');

  const recovered = await fixture({ start:false });
  simulator.state.modes.set(recovered.reference,'drop');
  await service().processOne(recovered.id);
  assert.equal((await recovered.read()).status,'PROCESSING');assert.equal(simulator.state.posts.get(recovered.reference),1);await finish(recovered);
  cases.push('an uncertain custom POST is recovered through the shared transaction-filtered provider lookup without a duplicate refund');

  const poison = await fixture({start:false});
  const poisonRow = await poison.read();
  await prisma.customOrderQueueRefund.update({where:{id:poison.id},data:{breakdownJson:{...poisonRow.breakdownJson,refundAmount:'invalid-money'}}});
  await service().processPending();
  assert.equal((await poison.read()).status,'NEEDS_ATTENTION');
  assert.equal(simulator.state.posts.get(poison.reference)||0,0);
  const failedResult = await fixture();
  const failedRow = await failedResult.read();
  await prisma.customOrderQueueRefund.update({where:{id:failedResult.id},data:{breakdownJson:{...failedRow.breakdownJson,settlement:{status:'RECORDED',currency:'NGN',amount:'invalid-money'}}}});
  await only(failedResult.id);await service().processPending();
  assert.equal((await failedResult.read()).status,'NEEDS_ATTENTION');assert.equal(await settled(failedResult.id),0);
  cases.push('invalid immutable money snapshots are quarantined without a provider POST or an endless polling retry');

  for (const family of ['standard','custom']) {
    const standard = family === 'standard' ? await paid({brandId}) : null;
    const item = standard ? {id:(await request(standard.order.id)).id, capture:standard.capture, reference:standard.reference} : await fixture({start:false});
    const table = family === 'standard' ? 'StandardOrderRefund' : 'CustomOrderQueueRefund';
    const {Prisma}=require('@prisma/client');
    const current = family === 'standard' ? await refunds.load(item.id) : await item.read();
    const target = family === 'standard' ? refunds.target(current) : service().providerTarget(current);
    const manual = await provider.submit(item.capture,target,`manual-${randomUUID()}`);
    const oldPosts=simulator.state.posts.get(item.reference);
    await prisma.$executeRaw(Prisma.sql`UPDATE ${Prisma.raw('"'+table+'"')} SET status='FAILED',"nextAttemptAt"=to_timestamp(0) AT TIME ZONE 'UTC' WHERE id=${item.id}::uuid`);
    if(standard)await onlyStandard([item.id]);else await only(item.id);
    const lookup=makeGate({status:'pending'});
    simulator.state.lookupGates.set(manual.id,[lookup]);
    const active=family==='standard'?refunds:service();
    const reconciling=watch(active.reconcile(item.id,manual.id,ownerId));
    await lookup.arrived.promise;
    const heldRow=(await prisma.$queryRaw(Prisma.sql`SELECT * FROM ${Prisma.raw('"'+table+'"')} WHERE id=${item.id}::uuid`))[0];
    assert.equal(heldRow.status,'NEEDS_ATTENTION');assert(heldRow.leaseToken);
    await Promise.all(Array.from({length:32},()=>active.processPending()));
    assert.equal(simulator.state.posts.get(item.reference),oldPosts,'Admin verification must freeze automatic submissions');
    await assert.rejects(()=>active.reconcile(item.id,manual.id,ownerId),/REFUND_RECONCILIATION_STATE_CHANGED/);
    lookup.release.resolve();assert.equal((await reconciling).status,'PROCESSING');
    assert.equal(simulator.state.posts.get(item.reference),oldPosts);
    cases.push(`${family} admin reconciliation freezes a due FAILED refund before real provider GET; 32 sweepers and a second admin cannot resubmit or replace the active owner`);
  }

  // A mixed capture has enough funds for two 90.00 refunds, but each refund
  // still requires a different provider identity, even when the amounts match.
  const mixed=await paid({brandId,amount:90});
  await prisma.paymentAttempt.update({where:{id:mixed.capture.id},data:{amount:200,settlementAmount:200}});
  simulator.state.transactions.get(mixed.reference).amount=20000;
  const standardId=(await request(mixed.order.id)).id;
  await onlyStandard([standardId]);await refunds.processPending();
  const standardRow=await prisma.standardOrderRefund.findUniqueOrThrow({where:{id:standardId}});
  const sibling=await fixture({start:false});
  await prisma.customOrderQueueRefund.update({where:{id:sibling.id},data:{paymentAttemptId:mixed.capture.id}});
  await prisma.customOrder.update({where:{id:sibling.order.id},data:{paymentReference:mixed.reference}});
  const {Prisma}=require('@prisma/client');
  await assert.rejects(()=>prisma.$executeRaw`UPDATE "CustomOrderQueueRefund" SET "providerRefundId"=${standardRow.providerRefundId} WHERE id=${sibling.id}::uuid`,/REFUND_PROVIDER_ID_ALREADY_LINKED/);
  const siblingOwner=randomUUID();const claimed=await service().claim(await sibling.read(),siblingOwner);assert(claimed);
  const sameProviderRefund=await provider.fetch(claimed.paymentAttempt,standardRow.providerRefundId);
  assert.equal(await service().linkResult(claimed,siblingOwner,sameProviderRefund),false);
  assert.equal((await sibling.read()).status,'NEEDS_ATTENTION');assert.equal((await sibling.read()).lastError,'REFUND_PROVIDER_ID_ALREADY_LINKED');
  assert.equal((await prisma.operationalAlert.findUniqueOrThrow({where:{dedupeKey:`queue-refund:${sibling.id}:attention`}})).metadata.code,'REFUND_PROVIDER_ID_ALREADY_LINKED');
  assert.equal(await settled(sibling.id),0);
  const [identity]=await prisma.$queryRaw`SELECT * FROM "ProviderRefundIdentity" WHERE provider='PAYSTACK' AND "providerRefundId"=${standardRow.providerRefundId}`;
  assert.equal(identity.standardRefundId,standardId);assert.equal(identity.customRefundId,null);
  await assert.rejects(()=>prisma.$executeRaw`DELETE FROM "ProviderRefundIdentity" WHERE provider='PAYSTACK' AND "providerRefundId"=${standardRow.providerRefundId}`,/REFUND_PROVIDER_IDENTITY_IMMUTABLE/);
  await assert.rejects(()=>prisma.$executeRaw`UPDATE "ProviderRefundIdentity" SET "customRefundId"=${sibling.id}::uuid,"standardRefundId"=NULL WHERE provider='PAYSTACK' AND "providerRefundId"=${standardRow.providerRefundId}`,/REFUND_PROVIDER_IDENTITY_IMMUTABLE/);
  await prisma.standardOrderRefund.update({where:{id:standardId},data:{status:'NEEDS_ATTENTION',providerRefundId:null}});
  await assert.rejects(()=>prisma.$executeRaw`UPDATE "CustomOrderQueueRefund" SET "providerRefundId"=${standardRow.providerRefundId} WHERE id=${sibling.id}::uuid`,/REFUND_PROVIDER_ID_ALREADY_LINKED/);
  cases.push('equal-amount standard/custom siblings of a mixed capture cannot reuse one provider refund, through either the service or raw SQL; clearing a link preserves identity history');

  const customFirst=await fixture();const customFirstRow=await customFirst.read();
  const standardSecond=await paid({brandId,amount:90});const secondId=(await request(standardSecond.order.id)).id;
  const {claimRefundSubmission}=require('../src/finance/refund-lease-query');
  const secondOwner=randomUUID();assert(await claimRefundSubmission(prisma,secondId,secondOwner,5));
  assert.equal(await refunds.linkProviderResult(secondId,secondOwner,customFirstRow.providerRefundId),false);
  const refused=await prisma.standardOrderRefund.findUniqueOrThrow({where:{id:secondId}});
  assert.equal(refused.status,'NEEDS_ATTENTION');assert.equal(refused.lastError,'REFUND_PROVIDER_ID_ALREADY_LINKED');
  await assert.rejects(()=>prisma.$executeRaw`UPDATE "StandardOrderRefund" SET "providerRefundId"=${customFirstRow.providerRefundId} WHERE id=${secondId}::uuid`,/REFUND_PROVIDER_ID_ALREADY_LINKED/);
  cases.push('a standard refund also refuses an identity already owned by a custom refund, including a different payment capture, with durable attention evidence');

  const expired=await fixture();
  await prisma.$executeRaw`UPDATE "CustomOrderQueueRefund" SET "leaseToken"=${randomUUID()}::uuid,"lockedAt"=clock_timestamp() AT TIME ZONE 'UTC'-INTERVAL '11 minutes' WHERE id=${expired.id}::uuid`;
  await assert.rejects(()=>prisma.$executeRaw`UPDATE "CustomOrderQueueRefund" SET status='SETTLED',"leaseToken"=NULL,"lockedAt"=NULL WHERE id=${expired.id}::uuid`,/REFUND_SETTLEMENT_OWNER_REQUIRED/);
  assert.equal(await settled(expired.id),0);
  cases.push('the database rejects a direct settlement by an expired custom-refund owner before any monetary side effects');

  const full=await fixture({refundAmount:100,quote:{refundKind:'POST_ACTIVE_FULL',releasedNet:20,releasedCommission:5,unreleasedGross:75}});
  await finish(full);
  cases.push('a full post-active custom refund closes the order and revises it once, preserves its paid parent capture, and ignores repeated processed webhooks');
  const partial=await fixture({refundAmount:40,quote:{captureAmount:40,vatAmount:0,refundKind:'POST_ACTIVE_PARTIAL',releasedNet:20,releasedCommission:5,unreleasedGross:15}});
  await prisma.customOrder.update({where:{id:partial.order.id},data:{status:'IN_PRODUCTION',lane:'ACTIVE',cancelledAt:null}});
  const partialBefore=await prisma.customOrder.findUniqueOrThrow({where:{id:partial.order.id}});
  simulator.state.refunds.get((await partial.read()).providerRefundId).status='processed';
  await only(partial.id);await service().processPending();
  const partialAfter=await prisma.customOrder.findUniqueOrThrow({where:{id:partial.order.id}});
  assert.equal((await partial.read()).status,'SETTLED');assert.equal(partialAfter.paymentStatus,'PAID');assert.equal(partialAfter.status,partialBefore.status);assert.equal(partialAfter.orderRevision,partialBefore.orderRevision+1);
  cases.push('a partial post-active refund settles its exact amount and revises the order once without closing production or clearing its paid status');
  const zero=await fixture({start:false,refundAmount:0});
  assert.equal(await service().processOne(zero.id),true);assert.equal((await zero.read()).status,'SETTLED');
  assert.equal(simulator.state.posts.get(zero.reference)||0,0);
  const mock=await fixture({start:false,mode:'mock'});
  process.env.NODE_ENV='test';delete process.env.CUSTOM_ORDER_QUEUE_REFUND_SIMULATION_ENABLED;
  assert.equal(await service().processOne(mock.id),false);assert.equal((await mock.read()).status,'FAILED');
  process.env.CUSTOM_ORDER_QUEUE_REFUND_SIMULATION_ENABLED='true';
  await prisma.customOrderQueueRefund.update({where:{id:mock.id},data:{nextAttemptAt:new Date(0)}});
  assert.equal(await service().processOne(mock.id),true);assert.equal((await mock.read()).status,'SETTLED');
  assert.equal(simulator.state.posts.get(mock.reference)||0,0);
  delete process.env.CUSTOM_ORDER_QUEUE_REFUND_SIMULATION_ENABLED;
  cases.push('zero refunds settle without a provider POST; mock refunds require an explicit local/test switch and use the same atomic order/ledger settlement');

  const adjustmentOwner=randomUUID(), adjustmentBrand=randomUUID();
  await prisma.user.create({data:{id:adjustmentOwner,username:adjustmentOwner,email:`${adjustmentOwner}@example.invalid`}});
  await prisma.brand.create({data:{id:adjustmentBrand,ownerId:adjustmentOwner,name:'Debt serialization fixture'}});
  const adjust=(params)=>prisma.$transaction(tx=>balance.raiseAdjustment(tx,{brandId:adjustmentBrand,currency:'NGN',reason:'Fixture',...params}),{timeout:20_000,maxWait:20_000});
  const key=`debt-owner-${randomUUID()}`;
  await Promise.all(Array.from({length:32},()=>adjust({type:'MANUAL_DEBIT',amount:30,sourceKey:key})));
  assert.equal(await prisma.brandBalanceAdjustment.count({where:{sourceKey:key}}),1);
  await assert.rejects(()=>prisma.$transaction(tx=>balance.raiseAdjustment(tx,{brandId,type:'MANUAL_DEBIT',amount:30,currency:'NGN',reason:'Wrong brand',sourceKey:key})),/BRAND_ADJUSTMENT_SOURCE_CONFLICT/);
  await assert.rejects(()=>adjust({type:'MANUAL_CREDIT',amount:30,sourceKey:key}),/BRAND_ADJUSTMENT_SOURCE_CONFLICT/);
  const secondKey=`debt-owner-${randomUUID()}`;await adjust({type:'MANUAL_DEBIT',amount:20,sourceKey:secondKey});
  const ordered=await prisma.brandBalanceAdjustment.findMany({where:{brandId:adjustmentBrand,type:'MANUAL_DEBIT'},orderBy:[{createdAt:'asc'},{id:'asc'}]});
  const creditKey=`debt-credit-${randomUUID()}`;
  await Promise.all(Array.from({length:32},()=>adjust({type:'MANUAL_CREDIT',amount:25,sourceKey:creditKey})));
  const first=await prisma.brandBalanceAdjustment.findUniqueOrThrow({where:{id:ordered[0].id}});
  assert.equal(first.recoveredAmount.toNumber(),25);
  assert.equal(await prisma.brandBalanceRecovery.count({where:{adjustmentId:{in:ordered.map(row=>row.id)}}}),1);
  const nextCredit=`debt-credit-${randomUUID()}`;
  await Promise.all(Array.from({length:32},()=>adjust({type:'MANUAL_CREDIT',amount:25,sourceKey:nextCredit})));
  const final=await prisma.brandBalanceAdjustment.findMany({where:{id:{in:ordered.map(row=>row.id)}}});
  assert(final.every(row=>row.status==='RECOVERED'));
  const recovery=await prisma.brandBalanceRecovery.aggregate({where:{adjustmentId:{in:ordered.map(row=>row.id)}},_sum:{amount:true}});
  assert.equal(recovery._sum.amount.toNumber(),50);
  cases.push('32 competing debit/credit commands preserve one source identity, refuse brand/type collisions and recover debts oldest-first exactly once');

  const parent = await paid({brandId});
  const orderHeld=deferred(), orderGo=deferred();
  releases.push(orderGo);
  const parentCommand=watch(prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT "_id" FROM "Order" WHERE "_id"=${parent.order.id}::uuid FOR UPDATE`;
    orderHeld.resolve();await orderGo.promise;await balance.lockBrand(tx,brandId);
  },{timeout:20_000}));
  await orderHeld.promise;
  const linked=watch(prisma.$transaction(tx=>balance.raiseAdjustment(tx,{brandId,type:'MANUAL_DEBIT',amount:1,currency:'NGN',reason:'Parent ordering fixture',sourceKey:`parent-${randomUUID()}`,orderId:parent.order.id}),{timeout:20_000}));
  let waiting=false;
  for(let i=0;i<100;i++){const rows=await prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;if(rows[0].n>0){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert(waiting);orderGo.resolve();await Promise.all([parentCommand,linked]);
  cases.push('a manual debt command waits on its source order before Brand locking, avoiding the actual order/FK/Brand lock inversion');
  return {cases};
  } finally {
    for (const value of gates) value.release.resolve();
    for (const value of releases) value.resolve();
    await Promise.allSettled(running);
  }
};
