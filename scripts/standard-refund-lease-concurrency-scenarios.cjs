const assert = require('node:assert/strict');

const deferred = () => {let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function arrived(signal, running) {
  let timeout;
  try {
    await Promise.race([signal.promise, running.then(()=>{throw Error('Refund worker finished before its gated lookup');}), new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Refund lookup did not reach its gate')),10000);})]);
  } finally {clearTimeout(timeout);}
}

module.exports = async function verifyStandardRefundLeaseOwnership({prisma, refunds, provider, paid, request, only, refundRow, posts, settledJournals, brandId}) {
  const cases=[];
  for (const late of ['error','pending','attention','processed','mismatch']) {
    const capture=await paid({brandId}), id=(await request(capture.order.id)).id;
    await only([id]); await refunds.processPending();
    assert.equal((await refundRow(id)).status,'PROCESSING');
    const first={ready:deferred(),release:deferred()}, second={ready:deferred(),release:deferred()};
    const originalFetch=provider.fetch.bind(provider); let calls=0, oldPoll, newPoll;
    const gated=Object.create(provider);
    gated.fetch=async (...args)=>{
      const reply=await originalFetch(...args), ordinal=++calls;
      assert(ordinal<=2,'Unexpected duplicate refund status lookup');
      const gate=ordinal===1?first:second;gate.ready.resolve();await gate.release.promise;
      if (ordinal===2) return reply;
      if (late==='error') throw Error('Synthetic late lookup transport failure');
      if (late==='mismatch') return {...reply,id:`wrong-${reply.id}`};
      return {...reply,state:late==='attention'?'FAILED':late==='processed'?'PROCESSED':'PENDING',rawStatus:late==='attention'?'failed':late==='processed'?'processed':'pending'};
    };
    refunds.provider=gated;
    try {
      oldPoll=refunds.poll(id);oldPoll.catch(()=>{});await arrived(first.ready,oldPoll);
      await prisma.$executeRaw`UPDATE "StandardOrderRefund" SET "lockedAt"=clock_timestamp() AT TIME ZONE 'UTC'-INTERVAL '11 minutes' WHERE id=${id}::uuid`;
      newPoll=refunds.poll(id);newPoll.catch(()=>{});await arrived(second.ready,newPoll);
      const currentOwner=await refundRow(id);
      first.release.resolve();await oldPoll;
      const afterOld=await refundRow(id);
      assert.equal(afterOld.status,'PROCESSING',`Late ${late} changed a replacement worker's state`);
      assert(afterOld.lockedAt,`Late ${late} cleared a replacement worker's claim`);
      assert.equal(afterOld.leaseToken,currentOwner.leaseToken,`Late ${late} changed a replacement worker's token`);
      assert.equal(await settledJournals(id),0,'Stale ownership cannot settle money');
      assert.equal(await prisma.operationalAlert.count({where: {dedupeKey: `standard-refund:${id}:attention`}}),0,'A stale lookup must not create an attention alert');
      second.release.resolve();await newPoll;
      const afterCurrent=await refundRow(id);
      assert.equal(afterCurrent.status,'PROCESSING');assert.equal(afterCurrent.lockedAt,null);assert.equal(afterCurrent.leaseToken,null);
      assert.equal(posts(capture.reference),1,'Polling must never create another provider refund');
    } finally {
      first.release.resolve();second.release.resolve();
      await Promise.allSettled([oldPoll,newPoll].filter(Boolean));
      refunds.provider=provider;
    }
    cases.push(`a late ${late} refund lookup cannot change or clear its replacement owner's claim, attention state or money; the current owner completes the pending lookup`);
  }
  const capture=await paid({brandId}), id=(await request(capture.order.id)).id;
  await only([id]);await refunds.processPending();
  const originalFetch=provider.fetch.bind(provider), gated=Object.create(provider);
  gated.fetch=async (...args)=>({...await originalFetch(...args),state:'PROCESSED',rawStatus:'processed'});
  const held=deferred(), release=deferred(), replacementFetched=deferred();let oldPoll, replacementPoll;
  const blocking=prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT "_id" FROM "Order" WHERE "_id"=${capture.order.id}::uuid FOR UPDATE`;
    held.resolve();await release.promise;
  },{timeout:15000});blocking.catch(()=>{});
  try {
    await Promise.race([held.promise,blocking]);
    refunds.provider=gated;
    oldPoll=refunds.poll(id);oldPoll.catch(()=>{});
    const deadline=Date.now()+5000;
    for(;;){
      const waiting=await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM "Order"%FOR NO KEY UPDATE%'`;
      if(waiting.length)break;
      assert(Date.now()<deadline,'Refund settlement did not reach the real order lock');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    await prisma.$executeRaw`UPDATE "StandardOrderRefund" SET "lockedAt"=clock_timestamp() AT TIME ZONE 'UTC'-INTERVAL '11 minutes' WHERE id=${id}::uuid`;
    const replacementProvider=Object.create(provider);
    replacementProvider.fetch=async (...args)=>{const reply=await originalFetch(...args);replacementFetched.resolve();return reply;};
    refunds.provider=replacementProvider;
    replacementPoll=refunds.poll(id);replacementPoll.catch(()=>{});
    await arrived(replacementFetched,replacementPoll);
    // Both callbacks now obey capture → order. Let the old callback acquire the
    // order and reject its expired owner before the new callback can apply.
    release.resolve();await blocking;await oldPoll;
    assert.equal(await replacementPoll,true);
    assert.equal((await refundRow(id)).status,'PROCESSING');
    assert.equal(await settledJournals(id),0);
    assert.equal(posts(capture.reference),1);
  }finally{
    release.resolve();await Promise.allSettled([blocking,oldPoll,replacementPoll].filter(Boolean));refunds.provider=provider;
  }
  cases.push('a processed response waiting on a real order lock loses ownership to a newer pending lookup and cannot settle escrow or ledger after the lock is released');

  const many=await paid({brandId}), manyId=(await request(many.order.id)).id;
  await only([manyId]);
  await Promise.all(Array.from({length:32},()=>refunds.processPending()));
  assert.equal(posts(many.reference),1);
  const claimed=await refundRow(manyId);
  assert.equal(claimed.status,'PROCESSING');assert.equal(claimed.leaseToken,null);assert.equal(claimed.attempts,1);
  cases.push('32 competing refund sweeps submit one provider refund and record one completed submission attempt');

  const blocked=await paid({brandId}), following=await paid({brandId});
  const blockedId=(await request(blocked.order.id)).id, followingId=(await request(following.order.id)).id;
  await only([blockedId,followingId]);
  await prisma.standardOrderRefund.update({where:{id:blockedId},data:{nextAttemptAt:new Date(Date.now()-10000)}});
  const rowHeld=deferred(), rowRelease=deferred();
  const holding=prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "StandardOrderRefund" WHERE id=${blockedId}::uuid FOR UPDATE`;
    rowHeld.resolve();await rowRelease.promise;
  },{timeout:15000});holding.catch(()=>{});
  try {
    await Promise.race([rowHeld.promise,holding]);
    await refunds.processPending();
    assert.equal(posts(blocked.reference),0);assert.equal(posts(following.reference),1);
  }finally{rowRelease.resolve();await holding;}
  await refunds.processPending();assert.equal(posts(blocked.reference),1);
  cases.push('a real locked refund at the queue head is skipped while a later due refund submits; the locked head processes after release');

  const clock=await paid({brandId}), clockId=(await request(clock.order.id)).id;
  await only([clockId]);await refunds.processPending();
  await prisma.$executeRaw`UPDATE "StandardOrderRefund" SET "nextAttemptAt"=clock_timestamp() AT TIME ZONE 'UTC'+INTERVAL '1 hour' WHERE id=${clockId}::uuid`;
  const actualNow=Date.now, realFetch=provider.fetch.bind(provider), clockProvider=Object.create(provider);let clockLookups=0;
  clockProvider.fetch=async (...args)=>{clockLookups++;return realFetch(...args);};
  refunds.provider=clockProvider;
  try {
    Date.now=()=>actualNow()+2*3600000;
    assert.deepEqual(await refunds.processPending(),{processed:0,stale:0});
    assert.equal(clockLookups,0);
  }finally{Date.now=actualNow;refunds.provider=provider;}
  cases.push('an application clock two hours ahead cannot poll a refund before its database due time');

  const staleOwner=require('node:crypto').randomUUID();
  await prisma.$executeRaw`UPDATE "StandardOrderRefund" SET status='SUBMITTING',"providerRefundId"=NULL,"leaseToken"=${staleOwner}::uuid,"lockedAt"=clock_timestamp() AT TIME ZONE 'UTC'-INTERVAL '11 minutes' WHERE id=${clockId}::uuid`;
  try {
    Date.now=()=>actualNow()-2*3600000;
    const recovered=await refunds.processPending();assert.equal(recovered.stale,1);
  }finally{Date.now=actualNow;}
  const recovered=await refundRow(clockId);
  assert.equal(recovered.status,'PROCESSING');assert.equal(recovered.leaseToken,null);
  assert.equal(posts(clock.reference),1);
  const [future]=await prisma.$queryRaw`SELECT "nextAttemptAt">clock_timestamp() AT TIME ZONE 'UTC' AS future FROM "StandardOrderRefund" WHERE id=${clockId}::uuid`;
  assert(future.future,'Recovery scheduling must also use the database clock');
  cases.push('an application clock two hours behind still recovers an expired submission by lookup and schedules its next poll from database time without resubmitting');
  return {cases};
};
