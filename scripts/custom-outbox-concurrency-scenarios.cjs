const assert=require('node:assert/strict');
const { randomUUID }=require('node:crypto');
const { CustomOrderSideEffectsService }=require('../src/custom-orders/custom-order-side-effects.service');
const { claimCustomOrderOutbox }=require('../src/custom-orders/custom-order-outbox-query');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

module.exports=async function verifyCustomOutbox({prisma,order,buyerId,notifications}){
  const [database]=await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database.name));
  await prisma.customOrderNotificationOutbox.updateMany({where:{status:{in:['PENDING','FAILED']}},data:{availableAt:new Date(Date.now()+86400000)}});
  const cases=[],handoffs=[];
  const queue={enqueueFanout:async(job,options)=>{handoffs.push({job,options});}};
  const service=new CustomOrderSideEffectsService(prisma,queue);
  service.logger={warn(){},error(){}};
  const create=(extra={})=>prisma.customOrderNotificationOutbox.create({data:{id:randomUUID(),customOrderId:order.id,recipientId:buyerId,notificationType:'CUSTOM_ORDER_PROGRESS_UPDATED',dedupeMs:0,payloadJson:{fixture:true},...extra}});
  const first=await create();
  const winners=await Promise.all(Array.from({length:32},()=>service.dispatchPendingNotifications(1)));
  assert.equal(winners.reduce((sum,value)=>sum+value,0),1);assert.equal(handoffs.length,1);
  assert.equal(handoffs[0].job.notificationId,first.id);assert.equal(handoffs[0].options.jobId,`custom-order-outbox-${first.id}`);
  cases.push('32 actual competing custom-outbox sweeps claim one event once and hand off one stable notification/job identity');

  const completion=await create();
  const [oldCompletion]=await claimCustomOrderOutbox(prisma,1);
  assert.equal(oldCompletion.id,completion.id);assert.equal(oldCompletion.attempts,1);
  assert.equal(+oldCompletion.lockExpiresAt-+oldCompletion.lockedAt,60000);
  assert.deepEqual(await claimCustomOrderOutbox(prisma,1),[]);
  await prisma.customOrderNotificationOutbox.update({where:{id:completion.id},data:{lockExpiresAt:new Date(Date.now()-1000)}});
  const [newCompletion]=await claimCustomOrderOutbox(prisma,1);
  assert.notEqual(newCompletion.lockOwner,oldCompletion.lockOwner);assert.equal(newCompletion.attempts,2);
  assert.equal(await service.dispatchNotificationEvent(oldCompletion),false);
  let current=await prisma.customOrderNotificationOutbox.findUniqueOrThrow({where:{id:completion.id}});
  assert.equal(current.status,'PROCESSING');assert.equal(current.lockOwner,newCompletion.lockOwner);
  assert.equal(await service.dispatchNotificationEvent(newCompletion),true);
  cases.push('unexpired custom-outbox claim is not stolen; expired claim recovers with a new owner/attempt and an old completion cannot overwrite the newer worker');

  const failure=await create();
  const [oldFailure]=await claimCustomOrderOutbox(prisma,1);
  await prisma.customOrderNotificationOutbox.update({where:{id:failure.id},data:{lockExpiresAt:new Date(Date.now()-1000)}});
  const [newFailure]=await claimCustomOrderOutbox(prisma,1);
  const failing=new CustomOrderSideEffectsService(prisma,{enqueueFanout:async()=>{throw Error('Late old worker failure');}});
  failing.logger={warn(){},error(){}};
  assert.equal(await failing.dispatchNotificationEvent(oldFailure),false);
  current=await prisma.customOrderNotificationOutbox.findUniqueOrThrow({where:{id:failure.id}});
  assert.equal(current.status,'PROCESSING');assert.equal(current.lockOwner,newFailure.lockOwner);assert.equal(current.lastError,null);
  await service.dispatchNotificationEvent(newFailure);
  cases.push('a late old failure cannot reset a newer custom-outbox claim, overwrite its error or schedule its retry');

  const dead=await create({status:'PROCESSING',attempts:8,lockOwner:'dead-fixture',lockExpiresAt:new Date(Date.now()-1000)});
  const beforeDead=handoffs.length;assert.equal(await service.dispatchPendingNotifications(1),0);
  current=await prisma.customOrderNotificationOutbox.findUniqueOrThrow({where:{id:dead.id}});
  assert.equal(current.status,'FAILED');assert.equal(current.lockOwner,null);assert(current.lastError.startsWith('DLQ_EXHAUSTED:'));
  assert.equal(handoffs.length,beforeDead);
  cases.push('a worker crash on the eighth attempt becomes an explicit exhausted failure after lease expiry instead of remaining PROCESSING forever');

  const retry=await create();let fail=true;const retryJobs=[];
  const recovering=new CustomOrderSideEffectsService(prisma,{enqueueFanout:async(job,options)=>{retryJobs.push({job,options});if(fail){fail=false;throw Error('Temporary queue outage');}}});
  recovering.logger={warn(){},error(){}};
  assert.equal(await recovering.dispatchPendingNotifications(1),0);
  current=await prisma.customOrderNotificationOutbox.findUniqueOrThrow({where:{id:retry.id}});
  assert.equal(current.status,'FAILED');assert.equal(current.attempts,1);assert(current.availableAt>new Date());
  assert.equal(await recovering.dispatchPendingNotifications(1),0);
  await prisma.customOrderNotificationOutbox.update({where:{id:retry.id},data:{availableAt:new Date(Date.now()-1000)}});
  assert.equal(await recovering.dispatchPendingNotifications(1),1);
  assert.deepEqual(retryJobs.map(row=>row.job.notificationId),[retry.id,retry.id]);
  assert.deepEqual(retryJobs.map(row=>row.options.jobId),[`custom-order-outbox-${retry.id}`,`custom-order-outbox-${retry.id}`]);
  cases.push('failed queue handoff backs off instead of retrying in a hot loop; due retry retains the same notification/job identity and acknowledges only its own claim');

  const head=await create(),later=await create(),held=deferred(),release=deferred();
  const blocker=prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "CustomOrderNotificationOutbox" WHERE id=${head.id}::uuid FOR UPDATE`;held.resolve();await release.promise;},{timeout:15000});
  await held.promise;
  try{
    assert.equal(await service.dispatchPendingNotifications(1),1);
    assert.equal((await prisma.customOrderNotificationOutbox.findUniqueOrThrow({where:{id:later.id}})).status,'COMPLETED');
  }finally{release.resolve();}
  await blocker;assert.equal(await service.dispatchPendingNotifications(1),1);
  cases.push('SKIP LOCKED lets a later due custom-outbox event progress while another transaction holds the FIFO head, then processes that head after release');

  let redisVerified=false;
  if(process.env.VERIFY_LOCAL_REDIS_OUTBOX==='true'){
    const { Queue, Worker, QueueEvents }=require('bullmq');
    const { buildRedisConnectionFromEnv }=require('../src/queue/queue.config');
    const { NotificationsQueueService }=require('../src/queue/notifications.queue.service');
    const { NotificationsProcessor }=require('../src/queue/notifications.processor');
    const connection=buildRedisConnectionFromEnv(process.env);
    assert(['127.0.0.1','localhost','::1'].includes(connection.host));
    const name=`wiez-outbox-regression-${randomUUID()}`;
    const realQueue=new Queue(name,{connection,defaultJobOptions:{removeOnComplete:true,removeOnFail:10}});
    const events=new QueueEvents(name,{connection:{...connection,maxRetriesPerRequest:null}});
    const processor=new NotificationsProcessor(notifications);
    const worker=new Worker(name,job=>processor.process(job),{connection:{...connection,maxRetriesPerRequest:null},concurrency:2});
    for(const emitter of [realQueue,events,worker])emitter.on('error',()=>{});
    try{
      await Promise.all([realQueue.waitUntilReady(),events.waitUntilReady(),worker.waitUntilReady()]);
      const event=await create();const jobId=`custom-order-outbox-${event.id}`;
      const waitForCompletion=async work=>{
        const done=deferred();const listener=entry=>{if(entry.jobId===jobId)done.resolve();};events.on('completed',listener);
        let timer;const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Isolated Redis worker did not complete')),10000);});
        try{const result=await work();await Promise.race([done.promise,timeout]);return result;}finally{clearTimeout(timer);events.off('completed',listener);}
      };
      const queued=new NotificationsQueueService(realQueue);
      const lostAck=new CustomOrderSideEffectsService(prisma,{enqueueFanout:async(job,options)=>{await queued.enqueueFanout(job,options);throw Error('Ack lost after Redis accepted the job');}});
      lostAck.logger={warn(){},error(){}};
      assert.equal(await waitForCompletion(()=>lostAck.dispatchPendingNotifications(1)),0);
      assert.equal(await prisma.notification.count({where:{id:event.id}}),1);
      // Production auto-removes completed jobs; wait for that removal so retry
      // really exercises durable inbox identity, not just queue job dedupe.
      for(let turn=0;turn<200&&await realQueue.getJob(jobId);turn++)await new Promise(resolve=>setTimeout(resolve,5));
      assert.equal(await realQueue.getJob(jobId),undefined);
      await prisma.customOrderNotificationOutbox.update({where:{id:event.id},data:{availableAt:new Date(Date.now()-1000)}});
      const retried=new CustomOrderSideEffectsService(prisma,queued);retried.logger={warn(){},error(){}};
      assert.equal(await waitForCompletion(()=>retried.dispatchPendingNotifications(1)),1);
      assert.equal(await prisma.notification.count({where:{id:event.id}}),1);
      assert.equal((await prisma.customOrderNotificationOutbox.findUniqueOrThrow({where:{id:event.id}})).status,'COMPLETED');
      redisVerified=true;
      cases.push('actual isolated Redis/BullMQ queue and real notification processor recover a lost enqueue acknowledgement; after the first job is auto-removed, retry still persists one inbox notification using its stable UUID');
    }finally{
      await worker.close();await events.close();assert(/^wiez-outbox-regression-[a-f0-9-]{36}$/.test(name));await realQueue.obliterate({force:true});await realQueue.close();
    }
  }
  return{cases,claimFencingVerified:true,redisVerified};
};
