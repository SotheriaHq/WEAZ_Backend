const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PaymentService } = require('../src/payment/payment.service');
const { FxRateService } = require('../src/payment/fx-rate.service');
const { NotificationsService } = require('../src/notifications/notifications.service');
const { StandardOrderFinanceSyncService } = require('../src/finance/standard-order-finance-sync.service');
const { StandardOrderEscrowService } = require('../src/finance/standard-order-escrow.service');
const { SettlementCalculatorService } = require('../src/finance/settlement-calculator.service');
const { SettlementPolicyService } = require('../src/finance/settlement-policy.service');
const { SettlementSnapshotService } = require('../src/finance/settlement-snapshot.service');
const { CommissionService } = require('../src/finance/commission.service');
const { FinancialDocumentsService } = require('../src/finance/financial-documents.service');
const { lockCheckoutSession } = require('../src/payment/checkout-session-query');
const { lockBuyerCart, consumePaidCartLines } = require('../src/bagging/cart-transaction.util');

module.exports = async function verifyUnifiedCheckout({ prisma, queries, buyer, owner, brand, configuration, version, finance, queue }) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_issue_race_[a-f0-9]{32}$/.test(database.name));
  const warnings = [], cases = [];
  const logger = { warn: message => warnings.push(message), error: message => warnings.push(message), debug() {}, log() {} };
  const config = { getNumber: async () => { throw Error('Persisted fixture policy required'); } };
  await prisma.settlementPolicy.create({ data: { orderType: 'STANDARD_ORDER', scope: 'PLATFORM', currency: 'NGN', releaseMode: 'HOLD_UNTIL_DELIVERY', upfrontReleaseEnabled: false, upfrontReleasePercent: 0, isDefault: true, effectiveFrom: new Date('2000-01-01') } });
  const calculator = new SettlementCalculatorService(new SettlementPolicyService(prisma, config), new CommissionService(prisma, config));
  const documents = new FinancialDocumentsService(prisma);
  const standard = new StandardOrderFinanceSyncService(prisma, new StandardOrderEscrowService(prisma, config, queue.ledger, calculator, new SettlementSnapshotService(prisma), {}), documents);
  const notifications = new NotificationsService(prisma, {}, { del: async () => {} }, { getConfig: () => undefined }, { getAppName: () => 'WIEZ', send: async () => {} }, {}, { enqueue: async () => {} }, { publishOrEmit: async () => true });
  notifications.logger = logger;
  const payments = new PaymentService(prisma, new FxRateService(prisma), standard, finance, notifications, {}, undefined, undefined, queue);
  payments.logger = logger;
  const createSession = (total = 2600, shipping = 0) => prisma.checkoutSession.create({ data: { buyerId: buyer.id, idempotencyKey: randomUUID(), subtotal: total - shipping, shippingCost: shipping, grandTotal: total, currency: 'NGN', expiresAt: new Date(Date.now()+3600000), customerName: 'Unified query fixture', shippingAddressJson: { state: 'LAGOS' } } });
  const createCapture = session => prisma.paymentAttempt.create({ data: { reference: `unified-query-${randomUUID()}`, buyerId: buyer.id, subjectType: 'UNIFIED_CHECKOUT', checkoutSessionId: session.id, providerMode: 'live', provider: 'PAYSTACK', paymentMethod: 'PAYSTACK', status: 'PAID', amount: session.grandTotal, currency: 'NGN', settlementCurrency: 'NGN', settlementAmount: session.grandTotal, confirmedAt: new Date() } });

  const standardSession = await createSession(67600,65000);
  const owners = Array.from({length:26},()=>randomUUID()), brands = owners.map(()=>randomUUID()), products = owners.map(()=>randomUUID());
  await prisma.user.createMany({data:owners.map(id=>({id,username:id,email:`${id}@example.invalid`,type:'BRAND'}))});
  await prisma.brand.createMany({data:brands.map((id,index)=>({id,ownerId:owners[index],name:`Unified brand ${index}`}))});
  await prisma.product.createMany({data:products.map((id,index)=>({id,brandId:brands[index],name:'Unified product',price:100,totalStock:9}))});
  const standardLines = [];
  for(let index=0;index<26;index++) {
    const cart = await prisma.cartItem.create({data:{id:randomUUID(),userId:buyer.id,productId:products[index],quantity:2}});
    const line = await prisma.checkoutSessionLine.create({data:{checkoutSessionId:standardSession.id,lineType:'STANDARD_ITEM',lineOrder:index,brandId:brands[index],productId:products[index],cartItemId:cart.id,quantity:1,unitPrice:100,lineTotal:100,itemSnapshotJson:{name:'Unified product',sizingMode:'NONE'}}});
    await prisma.inventoryReservation.create({data:{checkoutSessionId:standardSession.id,checkoutSessionLineId:line.id,productId:products[index],quantity:1,expiresAt:standardSession.expiresAt}});
    standardLines.push(line);
  }
  const standardCapture = await createCapture(standardSession);
  queries.length=0;
  const result = await payments.reconcilePaidUnifiedCheckoutFinalization(100);
  assert.deepEqual(result.failed,[]); assert.equal(result.finalized,1);
  assert.deepEqual(warnings,[]);
  const sessionLockReads=queries.filter(query=>/^\s*SELECT \* FROM "CheckoutSession"/.test(query)&&/FOR UPDATE/.test(query)).length;
  assert.equal(sessionLockReads,1);
  assert.equal(queries.filter(query=>/FROM "public"\."CheckoutSession"/.test(query)).length,0);
  const standardContextReads=queries.filter(query=>/FROM "Order" o JOIN "Brand" b/.test(query)&&/AS "brandOwnerId"/.test(query)).length;
  assert.equal(standardContextReads,1);
  const committedStandard = await prisma.order.findMany({where:{unifiedCheckoutSessionId:standardSession.id}});
  assert.equal(committedStandard.length,26);
  assert(committedStandard.every(row=>row.totalAmount.toFixed(2)==='2600.00'&&row.shippingCost.toFixed(2)==='2500.00'&&row.paymentStatus==='PAID'));
  assert.equal(await prisma.orderItem.count({where:{orderId:{in:committedStandard.map(row=>row.id)}}}),26);
  assert.equal(await prisma.escrowHold.count({where:{orderId:{in:committedStandard.map(row=>row.id)}}}),26);
  assert.equal(await prisma.inventoryReservation.count({where:{checkoutSessionId:standardSession.id,status:'COMMITTED'}}),26);
  assert.equal(await prisma.cartItem.count({where:{id:{in:standardLines.map(row=>row.cartItemId)},quantity:1}}),26);
  assert.equal(await prisma.financialDocument.count({where:{paymentAttemptId:standardCapture.id,type:'BUYER_RECEIPT'}}),1);
  const journalsBefore = await prisma.ledgerTransaction.count();
  await payments.finalizeUnifiedCheckoutAttempt(standardCapture.reference,buyer.id);
  assert.equal(await prisma.order.count({where:{unifiedCheckoutSessionId:standardSession.id}}),26);
  assert.equal(await prisma.ledgerTransaction.count(),journalsBefore);
  assert.equal(await prisma.cartItem.count({where:{id:{in:standardLines.map(row=>row.cartItemId)},quantity:1}}),26);
  cases.push('actual paid unified reconciliation finalizes26 standard lines across26 brands with one locked native session read plus one line page and one order-owner JOIN;26 orders/items/escrow holds, one captured receipt, committed reservations and only paid cart quantities consumed; replay creates no order, money or extra cart removal');

  const customSession = await createSession();
  const intents = [];
  for(let index=0;index<26;index++) intents.push(await prisma.customOrderCheckoutIntent.create({data:{buyerId:buyer.id,configurationId:configuration.id,configurationVersionId:version.id,previewHash:randomUUID(),requestSnapshotJson:{customerName:'Unified buyer',measurementValues:{},chartLock:{}},buyerPriceSummaryJson:{grandTotal:100},expiresAt:customSession.expiresAt}}));
  await prisma.checkoutSessionLine.createMany({data:intents.map((intent,index)=>({id:randomUUID(),checkoutSessionId:customSession.id,lineType:'CUSTOM_ORDER',lineOrder:index,brandId:brand.id,checkoutIntentId:intent.id,unitPrice:100,lineTotal:100,itemSnapshotJson:{sourceTitle:'Unified custom',sourceBrandName:brand.name}}))});
  const customCapture=await createCapture(customSession);
  const lines=await prisma.checkoutSessionLine.findMany({where:{checkoutSessionId:customSession.id}});
  await prisma.paymentAttemptCheckoutIntentLink.createMany({data:lines.map(line=>({paymentAttemptId:customCapture.id,checkoutIntentId:line.checkoutIntentId,checkoutSessionId:customSession.id,checkoutSessionLineId:line.id}))});
  queries.length=0;
  const customResult=await payments.reconcilePaidUnifiedCheckoutFinalization(100);
  assert.deepEqual(customResult.failed,[]); assert.equal(customResult.finalized,1);
  assert.deepEqual(warnings,[]);
  const intentReads=queries.filter(query=>/^\s*SELECT\b/i.test(query)&&/FROM "public"\."CustomOrderCheckoutIntent"/.test(query)).length;
  const configurationReads=queries.filter(query=>/^\s*SELECT\b/i.test(query)&&/FROM "public"\."CustomOrderConfiguration"/.test(query)).length;
  const versionReads=queries.filter(query=>/^\s*SELECT\b/i.test(query)&&/FROM "public"\."CustomOrderConfigurationVersion"/.test(query)).length;
  assert.equal(intentReads,1); assert.equal(configurationReads,1); assert.equal(versionReads,1);
  const customOrders=await prisma.customOrder.findMany({where:{unifiedCheckoutSessionId:customSession.id}});
  assert.equal(customOrders.length,26); assert(customOrders.every(row=>row.queuePolicyVersion===1&&row.paymentStatus==='PAID'&&row.lane==='PENDING'));
  assert.equal(await prisma.customOrderLedgerAllocation.count({where:{customOrderId:{in:customOrders.map(row=>row.id)},allocationType:'PLACEMENT_CAPTURE',status:'HELD'}}),26);
  assert.equal(await prisma.paymentAttemptCheckoutIntentLink.count({where:{paymentAttemptId:customCapture.id,status:'COMMITTED'}}),26);
  const beforeCustomJournals=await prisma.ledgerTransaction.count();
  await payments.finalizeUnifiedCheckoutAttempt(customCapture.reference,buyer.id);
  assert.equal(await prisma.customOrder.count({where:{unifiedCheckoutSessionId:customSession.id}}),26);
  assert.equal(await prisma.ledgerTransaction.count(),beforeCustomJournals);
  cases.push('actual26 fresh custom unified lines share one intent/configuration/version scan, create26 orders in one batch and retain individual locked queue admissions/current capacity/financial guards,26 held captures and committed links; replay posts no duplicate order or money');

  const refusedSession=await createSession(100);
  await prisma.checkoutSessionLine.create({data:{checkoutSessionId:refusedSession.id,lineType:'CUSTOM_ORDER',unitPrice:100,lineTotal:100,itemSnapshotJson:{}}});
  const refusedCapture=await createCapture(refusedSession);
  await assert.rejects(payments.finalizeUnifiedCheckoutAttempt(refusedCapture.reference,buyer.id),/missing checkout intent linkage/);
  assert.equal((await prisma.checkoutSession.findUniqueOrThrow({where:{id:refusedSession.id}})).status,'PENDING_PAYMENT');
  assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({where:{id:refusedCapture.id}})).finalizationFailureCount,1);
  assert.equal(await prisma.customOrder.count({where:{unifiedCheckoutSessionId:refusedSession.id}}),0);
  await assert.rejects(payments.finalizeUnifiedCheckoutAttempt(standardCapture.reference,owner.id),/not found/);
  assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({where:{id:standardCapture.id}})).finalizationFailureCount,0);
  assert.equal(await prisma.$transaction(tx=>lockCheckoutSession(tx,randomUUID())),null);
  cases.push('missing custom intent refuses completion and rolls back orders while recording recoverable finalization failure; foreign buyer cannot finalize or alter failure count, and missing native locked session returns null');
  const deferred = () => { let resolve; const promise = new Promise(done => { resolve=done; }); return {promise,resolve}; };
  const waitForPid = async pid => {
    for(let turn=0;turn<300;turn++) {
      const rows=await prisma.$queryRaw`SELECT 1 AS waiting FROM pg_stat_activity WHERE pid=${pid} AND wait_event_type='Lock'`;
      if(rows.length) return;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    throw Error('Expected real lock wait');
  };
  const ready=deferred(), release=deferred(), waiter=deferred();
  const writer=prisma.$transaction(async tx=>{
    await lockCheckoutSession(tx,standardSession.id);ready.resolve();await release.promise;
    await tx.checkoutSession.update({where:{id:standardSession.id},data:{customerName:'Committed current name'}});
  },{timeout:15000});
  await ready.promise;
  const reader=prisma.$transaction(async tx=>{
    const [row]=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;waiter.resolve(row.pid);
    return lockCheckoutSession(tx,standardSession.id);
  },{timeout:15000});
  try { await waitForPid(await waiter.promise); } finally {release.resolve();}
  const [,currentSession]=await Promise.all([writer,reader]);
  assert.equal(currentSession.customerName,'Committed current name');
  assert.equal(currentSession.grandTotal.toFixed(2),'67600.00');
  assert.equal(currentSession.lines.length,26);
  const cartReady=deferred(), cartRelease=deferred(), cartWaiter=deferred();
  const cartWriter=prisma.$transaction(async tx=>{
    await lockBuyerCart(tx,buyer.id);cartReady.resolve();await cartRelease.promise;
    await tx.cartItem.update({where:{id:standardLines[0].cartItemId},data:{quantity:5}});
  },{timeout:15000});
  await cartReady.promise;
  const cartReader=prisma.$transaction(async tx=>{
    const [row]=await tx.$queryRaw`SELECT pg_backend_pid() AS pid`;cartWaiter.resolve(row.pid);
    await consumePaidCartLines(tx,buyer.id,[{cartItemId:standardLines[0].cartItemId,quantity:1}]);
  },{timeout:15000});
  try {await waitForPid(await cartWaiter.promise);} finally {cartRelease.resolve();}
  await Promise.all([cartWriter,cartReader]);
  assert.equal((await prisma.cartItem.findUniqueOrThrow({where:{id:standardLines[0].cartItemId}})).quantity,4);
  cases.push('native session lock waits for a real writer then returns committed current fields/native Decimal and26lines; real buyer-cart advisory lock uses executable SQL without void decoding and a competing paid consumer preserves the four newly retained quantities');
  return {cases,sessionLockReads,standardContextReads,intentReadsFor26:intentReads,configurationReadsFor26:configurationReads,versionReadsFor26:versionReads};
};
