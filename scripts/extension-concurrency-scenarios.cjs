const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const { CustomOrdersService }=require('../src/custom-orders/custom-orders.service');
const { CustomOrderOpsCronService }=require('../src/custom-order-ops/custom-order-ops.cron.service');
const { CustomOrderSideEffectsService }=require('../src/custom-orders/custom-order-side-effects.service');
const { CustomOrderAccessService }=require('../src/custom-orders/custom-order-access.service');
const { BrandPermissionService }=require('../src/brands/permissions/brand-permission.service');
const { clearActiveAdminIdsCache }=require('../src/custom-orders/custom-order-admin-attention');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

module.exports=async function verifyExtensions({prisma,buyer,owner,brand,createOrder,waitForBlocked,ledger,queue}){
  const [database]=await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_issue_race_[a-f0-9]{32}$/.test(database.name));
  clearActiveAdminIdsCache();
  const cases=[],warnings=[];
  const sideEffects=new CustomOrderSideEffectsService(prisma,{});
  const service=new CustomOrdersService(prisma,{},sideEffects,{},ledger,new CustomOrderAccessService(prisma,new BrandPermissionService(prisma)),{},{},undefined,undefined,queue);
  const originalNotifications=service.notifications,emissions=[];
  service.notifications={emitOrderUpdated:async(recipients,payload)=>{emissions.push({recipients,payload});}};
  const cron=new CustomOrderOpsCronService(prisma,sideEffects,{}, {},{},ledger,queue);
  cron.logger={warn:message=>warnings.push(message),log(){}};
  const freshOrder=async()=>{
    const order=await createOrder();
    return prisma.customOrder.update({where:{id:order.id},data:{status:'IN_PRODUCTION',promisedProductionAt:new Date(Date.now()+7*86400000),promisedDispatchAt:new Date(Date.now()+7*86400000),promisedDeliveryAt:new Date(Date.now()+9*86400000),buyerAcceptanceWindowEndsAt:null}});
  };
  const request=(order,respondByAt=new Date(Date.now()+3600000),targetType='PRODUCTION')=>prisma.customOrderExtensionRequest.create({data:{customOrderId:order.id,requestedByBrandId:brand.id,targetType,requestedExtraDays:3,reason:'Concurrency fixture',respondByAt}});
  const decision={response:'ACCEPTED'};
  try{
    const order=await freshOrder();
    const created=await Promise.allSettled(Array.from({length:26},()=>service.createExtensionRequest(owner.id,brand.id,order.id,{targetType:'PRODUCTION',requestedExtraDays:3,reason:'Concurrent request'})));
    assert.equal(created.filter(row=>row.status==='fulfilled').length,1);
    assert.equal(await prisma.customOrderExtensionRequest.count({where:{customOrderId:order.id}}),1);
    assert.equal(await prisma.customOrderTimelineEvent.count({where:{customOrderId:order.id,eventType:'EXTENSION_REQUESTED'}}),1);
    cases.push('26 actual concurrent brand requests serialize on the current order and create one outstanding request/timeline event;25 conflicting requests are refused after the lock');
    const extension=await prisma.customOrderExtensionRequest.findFirstOrThrow({where:{customOrderId:order.id}});
    const approved=await Promise.allSettled(Array.from({length:26},()=>service.respondToExtension(buyer.id,order.id,extension.id,decision)));
    assert.equal(approved.filter(row=>row.status==='fulfilled').length,1);
    const once=await prisma.customOrder.findUniqueOrThrow({where:{id:order.id}});
    assert.equal(once.approvedExtensionCount,1);assert.equal(once.totalExtensionDaysGranted,3);
    assert.equal(+once.promisedDeliveryAt-+order.promisedDeliveryAt,3*86400000);
    assert.equal(+once.originalPromisedDeliveryAt,+order.promisedDeliveryAt);
    assert.equal(await prisma.customOrderTimelineEvent.count({where:{customOrderId:order.id,eventType:'EXTENSION_RESOLVED'}}),1);
    cases.push('26 actual competing shopper approvals grant three days once, preserve the original promise and increment the extension budget/timeline exactly once');
    const counterOrder=await freshOrder(),counter=await request(counterOrder);
    await service.respondToExtension(buyer.id,counterOrder.id,counter.id,{response:'COUNTERED',counterDays:2});
    const counterReplies=await Promise.allSettled(Array.from({length:26},()=>service.respondToBuyerCounter(owner.id,brand.id,counterOrder.id,counter.id,decision)));
    assert.equal(counterReplies.filter(row=>row.status==='fulfilled').length,1);
    const counterOnce=await prisma.customOrder.findUniqueOrThrow({where:{id:counterOrder.id}});
    assert.equal(counterOnce.approvedExtensionCount,1);assert.equal(counterOnce.totalExtensionDaysGranted,2);
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:counter.id}})).appliedExtraDays,2);
    cases.push('a real shopper counter followed by26 competing brand approvals grants the current two-day counter once and preserves budget conservation');

    const budgetOrder=await freshOrder(),budgetRequest=await request(budgetOrder),budgetReady=deferred(),budgetRelease=deferred();
    const budgetWriter=prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM "CustomOrder" WHERE id=${budgetOrder.id}::uuid FOR UPDATE`;
      budgetReady.resolve();await budgetRelease.promise;
      await tx.customOrder.update({where:{id:budgetOrder.id},data:{approvedExtensionCount:2,totalExtensionDaysGranted:6}});
    },{timeout:15000});
    await budgetReady.promise;
    const blockedAnswer=service.respondToExtension(buyer.id,budgetOrder.id,budgetRequest.id,decision);
    const refusedAnswer=assert.rejects(blockedAnswer,/LIMIT_REACHED/);
    try{await waitForBlocked();}finally{budgetRelease.resolve();}
    await Promise.all([budgetWriter,refusedAnswer]);
    assert.equal((await prisma.customOrder.findUniqueOrThrow({where:{id:budgetOrder.id}})).totalExtensionDaysGranted,6);
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:budgetRequest.id}})).buyerResponseStatus,'OPEN');
    // Close the deliberately exhausted fixture so subsequent expiry scans stay isolated.
    await prisma.customOrderExtensionRequest.update({where:{id:budgetRequest.id},data:{buyerResponseStatus:'VOIDED'}});
    cases.push('a shopper waits behind a real budget writer and rechecks the committed exhausted budget before granting; no stale promise shift or request acceptance');

    const winnerOrder=await freshOrder(),winnerRequest=await request(winnerOrder,new Date(Date.now()+1500));
    const responseWritten=deferred(),responseRelease=deferred();let held=false;
    service.prisma=new Proxy(prisma,{get(target,key){
      if(key==='$transaction')return (run,options)=>target.$transaction(tx=>run(new Proxy(tx,{get(inner,field){
        if(field==='customOrderExtensionRequest')return new Proxy(inner[field],{get(delegate,method){
          if(method==='update')return async args=>{const result=await delegate.update(args);if(args.where.id===winnerRequest.id&&!held){held=true;responseWritten.resolve();await responseRelease.promise;}return result;};
          const value=delegate[method];return typeof value==='function'?value.bind(delegate):value;
        }});
        const value=inner[field];return typeof value==='function'?value.bind(inner):value;
      }})),{...options,timeout:15000});
      const value=target[key];return typeof value==='function'?value.bind(target):value;
    }});
    const winningAnswer=service.respondToExtension(buyer.id,winnerOrder.id,winnerRequest.id,decision);
    await Promise.race([responseWritten.promise,winningAnswer.then(()=>{throw Error('Expected approval to pause before commit');})]);
    await new Promise(resolve=>setTimeout(resolve,Math.max(1,+winnerRequest.respondByAt-Date.now()+25)));
    const expiryWaiter=cron.expireOpenExtensionRequests();
    try{await waitForBlocked();}finally{responseRelease.resolve();}
    await Promise.all([winningAnswer,expiryWaiter]);service.prisma=prisma;
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:winnerRequest.id}})).buyerResponseStatus,'ACCEPTED');
    assert.equal(await prisma.customOrderTimelineEvent.count({where:{customOrderId:winnerOrder.id,eventType:'EXTENSION_EXPIRED'}}),0);
    assert.equal(await prisma.customOrderNotificationOutbox.count({where:{customOrderId:winnerOrder.id,payloadJson:{path:['response'],equals:'EXPIRED'}}}),0);
    cases.push('an actual shopper approval validated before its deadline commits while expiry waits on the same order; the losing cron emits no expired timeline, false attention or expired notice');

    const expiredOrder=await freshOrder(),expiredRequest=await request(expiredOrder,new Date(Date.now()-1000));
    await cron.expireOpenExtensionRequests();
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:expiredRequest.id}})).buyerResponseStatus,'EXPIRED');
    assert.equal(await prisma.customOrderNotificationOutbox.count({where:{customOrderId:expiredOrder.id,payloadJson:{path:['response'],equals:'EXPIRED'}}}),2);
    await assert.rejects(service.respondToExtension(buyer.id,expiredOrder.id,expiredRequest.id,decision),/no longer open/);
    await cron.expireOpenExtensionRequests();
    assert.equal(await prisma.customOrderTimelineEvent.count({where:{customOrderId:expiredOrder.id,eventType:'EXTENSION_EXPIRED'}}),1);
    assert.equal((await prisma.customOrder.findUniqueOrThrow({where:{id:expiredOrder.id}})).approvedExtensionCount,0);
    cases.push('expiry wins once, persists two buyer/owner outbox notices and one history event, refuses a later approval and repeats without extra budget or notices');

    const rollbackOrder=await freshOrder(),rollbackRequest=await request(rollbackOrder,new Date(Date.now()-1000));
    assert(/^[a-f0-9-]{36}$/.test(rollbackOrder.id));
    await prisma.$executeRawUnsafe(`ALTER TABLE "CustomOrderNotificationOutbox" ADD CONSTRAINT fixture_expiry_outbox_failure CHECK ("customOrderId" <> '${rollbackOrder.id}'::uuid)`);
    await cron.expireOpenExtensionRequests();
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:rollbackRequest.id}})).buyerResponseStatus,'OPEN');
    assert.equal((await prisma.customOrder.findUniqueOrThrow({where:{id:rollbackOrder.id}})).adminInterventionAt,null);
    assert.equal(await prisma.customOrderTimelineEvent.count({where:{customOrderId:rollbackOrder.id,eventType:'EXTENSION_EXPIRED'}}),0);
    await prisma.$executeRawUnsafe('ALTER TABLE "CustomOrderNotificationOutbox" DROP CONSTRAINT fixture_expiry_outbox_failure');
    await cron.expireOpenExtensionRequests();
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:rollbackRequest.id}})).buyerResponseStatus,'EXPIRED');
    assert.equal(await prisma.customOrderNotificationOutbox.count({where:{customOrderId:rollbackOrder.id,payloadJson:{path:['response'],equals:'EXPIRED'}}}),2);
    cases.push('a real outbox CHECK violation rolls expiry, intervention and timeline back together; after the fault is removed, the next sweep commits state/history/notices atomically');

    const productionDone=await freshOrder(),deliveryOpen=await freshOrder();
    const doneRequest=await request(productionDone,undefined,'PRODUCTION'),deliveryRequest=await request(deliveryOpen,undefined,'DELIVERY');
    await prisma.customOrder.updateMany({where:{id:{in:[productionDone.id,deliveryOpen.id]}},data:{status:'READY_FOR_DISPATCH'}});
    await cron.voidSupersededExtensionRequests();
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:doneRequest.id}})).buyerResponseStatus,'VOIDED');
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:deliveryRequest.id}})).buyerResponseStatus,'OPEN');
    await assert.rejects(service.respondToExtension(buyer.id,productionDone.id,doneRequest.id,decision),/no longer open/);
    cases.push('stage-aware voiding cancels a completed production request while retaining an eligible delivery request on READY_FOR_DISPATCH; stale shopper decisions cannot resurrect the voided request');
    const failNotice=async(order,work,filter='')=>{
      assert(/^[a-f0-9-]{36}$/.test(order.id));
      const before=emissions.length;
      await prisma.$executeRawUnsafe(`ALTER TABLE "CustomOrderNotificationOutbox" ADD CONSTRAINT fixture_manual_extension_failure CHECK ("customOrderId"<>'${order.id}'::uuid ${filter})`);
      try{await assert.rejects(work());}finally{await prisma.$executeRawUnsafe('ALTER TABLE "CustomOrderNotificationOutbox" DROP CONSTRAINT fixture_manual_extension_failure');}
      assert.equal(emissions.length,before,'Rolled-back decisions must not emit realtime state');
      assert.equal(await prisma.customOrderNotificationOutbox.count({where:{customOrderId:order.id}}),0);
    };

    const createRollback=await freshOrder();
    const createCommand=()=>service.createExtensionRequest(owner.id,brand.id,createRollback.id,{targetType:'PRODUCTION',requestedExtraDays:3,reason:'Atomic request'});
    await failNotice(createRollback,createCommand);
    assert.equal(await prisma.customOrderExtensionRequest.count({where:{customOrderId:createRollback.id}}),0);
    assert.equal(await prisma.customOrderTimelineEvent.count({where:{customOrderId:createRollback.id,eventType:'EXTENSION_REQUESTED'}}),0);
    await createCommand();
    const createdNotice=await prisma.customOrderNotificationOutbox.findFirstOrThrow({where:{customOrderId:createRollback.id}});
    const committedRequest=await prisma.customOrderExtensionRequest.findFirstOrThrow({where:{customOrderId:createRollback.id}});
    assert.equal(createdNotice.recipientId,buyer.id);assert(createdNotice.payloadJson.targetUrl.endsWith(`/extensions/${committedRequest.id}`));
    cases.push('extension request/outbox constraint failure rolls back request and timeline with no realtime event; retry commits the shopper notice with the exact request link');

    const approveRollback=await freshOrder(),approveRequest=await request(approveRollback);
    const approveCommand=()=>service.respondToExtension(buyer.id,approveRollback.id,approveRequest.id,decision);
    await failNotice(approveRollback,approveCommand);
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:approveRequest.id}})).buyerResponseStatus,'OPEN');
    const approvalBefore=await prisma.customOrder.findUniqueOrThrow({where:{id:approveRollback.id}});
    assert.equal(approvalBefore.totalExtensionDaysGranted,0);assert.equal(+approvalBefore.promisedDeliveryAt,+approveRollback.promisedDeliveryAt);
    await approveCommand();
    assert.equal(await prisma.customOrderNotificationOutbox.count({where:{customOrderId:approveRollback.id,recipientId:owner.id}}),1);
    await assert.rejects(approveCommand());
    assert.equal(await prisma.customOrderNotificationOutbox.count({where:{customOrderId:approveRollback.id}}),1);
    cases.push('shopper extension approval and brand notice commit atomically; outbox failure leaves dates/budget/request untouched and replay cannot grant or notify twice');

    const counterRollback=await freshOrder(),counterRequest=await request(counterRollback);
    const counterCommand=()=>service.respondToExtension(buyer.id,counterRollback.id,counterRequest.id,{response:'COUNTERED',counterDays:2});
    await failNotice(counterRollback,counterCommand);
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:counterRequest.id}})).buyerResponseStatus,'OPEN');
    await counterCommand();
    assert.equal(await prisma.customOrderNotificationOutbox.count({where:{customOrderId:counterRollback.id,notificationType:'CUSTOM_ORDER_BUYER_COUNTERED',recipientId:owner.id}}),1);
    cases.push('shopper counter and brand notice roll back together when durable handoff fails, then retry persists one current counter notice');

    // Isolate counter approval rollback from its already committed brand notice.
    await prisma.customOrderNotificationOutbox.deleteMany({where:{customOrderId:counterRollback.id}});
    const brandApproval=()=>service.respondToBuyerCounter(owner.id,brand.id,counterRollback.id,counterRequest.id,decision);
    await failNotice(counterRollback,brandApproval);
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:counterRequest.id}})).buyerResponseStatus,'COUNTERED');
    assert.equal((await prisma.customOrder.findUniqueOrThrow({where:{id:counterRollback.id}})).totalExtensionDaysGranted,0);
    await brandApproval();
    assert.equal((await prisma.customOrder.findUniqueOrThrow({where:{id:counterRollback.id}})).totalExtensionDaysGranted,2);
    assert.equal(await prisma.customOrderNotificationOutbox.count({where:{customOrderId:counterRollback.id,recipientId:buyer.id}}),1);
    cases.push('brand counter approval/date grant/shopper notice are atomic and no realtime event escapes an outbox rollback');

    const adminId=randomUUID();
    await prisma.user.create({data:{id:adminId,email:`${adminId}@example.invalid`,username:adminId,role:'Admin',status:'ACTIVE'}});
    const rejectRollback=await freshOrder(),rejectRequest=await request(rejectRollback);
    const rejectCommand=()=>service.respondToExtension(buyer.id,rejectRollback.id,rejectRequest.id,{response:'REJECTED'});
    await failNotice(rejectRollback,rejectCommand,`OR "notificationType"<>'CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED'`);
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:rejectRequest.id}})).buyerResponseStatus,'OPEN');
    assert.equal(await prisma.customOrderDispute.count({where:{customOrderId:rejectRollback.id}}),0);
    const rejectedBefore=await prisma.customOrder.findUniqueOrThrow({where:{id:rejectRollback.id}});
    assert.equal(rejectedBefore.status,'IN_PRODUCTION');assert.equal(rejectedBefore.adminAttentionRequiredAt,null);
    await rejectCommand();
    const rejectedAfter=await prisma.customOrder.findUniqueOrThrow({where:{id:rejectRollback.id}});
    assert.equal(rejectedAfter.status,'DISPUTED');assert(rejectedAfter.adminAttentionRequiredAt);
    const notices=await prisma.customOrderNotificationOutbox.findMany({where:{customOrderId:rejectRollback.id}});
    assert(notices.some(row=>row.recipientId===owner.id&&row.notificationType==='CUSTOM_ORDER_BUYER_REJECTED_EXTENSION'));
    assert(notices.some(row=>row.recipientId===adminId&&row.notificationType==='CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED'));
    assert.equal(notices.find(row=>row.recipientId===buyer.id).actorId,null);
    assert.equal(await prisma.customOrderDispute.count({where:{customOrderId:rejectRollback.id}}),1);
    cases.push('failure of the last admin notice rolls back rejection/dispute/admin flag and earlier buyer/brand notices; retry commits all recipients and preserves the system-authored shopper confirmation');

    const flagRollback=await freshOrder(),flagRequest=await request(flagRollback);
    assert(/^[a-f0-9-]{36}$/.test(flagRollback.id));
    await prisma.$executeRawUnsafe(`ALTER TABLE "CustomOrder" ADD CONSTRAINT fixture_manual_attention_failure CHECK (id<>'${flagRollback.id}'::uuid OR "adminAttentionRequiredAt" IS NULL)`);
    try{await assert.rejects(service.respondToExtension(buyer.id,flagRollback.id,flagRequest.id,{response:'REJECTED'}));}
    finally{await prisma.$executeRawUnsafe('ALTER TABLE "CustomOrder" DROP CONSTRAINT fixture_manual_attention_failure');}
    assert.equal((await prisma.customOrderExtensionRequest.findUniqueOrThrow({where:{id:flagRequest.id}})).buyerResponseStatus,'OPEN');
    assert.equal(await prisma.customOrderDispute.count({where:{customOrderId:flagRollback.id}}),0);
    assert.equal(await prisma.customOrderNotificationOutbox.count({where:{customOrderId:flagRollback.id}}),0);
    cases.push('an actual required admin-attention flag failure aborts the whole extension rejection instead of leaving a disputed order with missing operational ownership');
    return {cases,concurrentRequests:26,concurrentApprovals:26,concurrentCounterApprovals:26,atomicOutboxRollback:true,manualNoticeAtomicity:true};
  }finally{service.prisma=prisma;service.notifications=originalNotifications;clearActiveAdminIdsCache();}
};
