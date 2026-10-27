const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { claimTagJobs, failTagJob, acknowledgeTagProjections, readTagProjectionJobs } = require('../src/tags/tag-projection-query');

module.exports = async function verifyTagProjectionRecovery({ prisma, pool, index, evidence, ownerId, brandId }) {
  const cases = evidence.cases;
  const project = jobs => index.syncEntitiesTags(jobs.map(job => ({ ...job, previousTags: [], nextTags: [], options: { skipModerated: true } })), jobs);
  const bindings = id => prisma.tagBinding.findMany({ where: { entityId: id }, include: { tag: true } });
  const job = async id => (await pool.query('SELECT * FROM "TagProjectionOutbox" WHERE "entityId"=$1', [id])).rows[0];
  const drain = async () => {
    for (let i = 0; i < 12; i++) {
      await index.recoverTagProjections();
      const due = await pool.query(`SELECT 1 FROM "TagProjectionOutbox" WHERE attempts<8 AND status IN ('PENDING','FAILED') AND "availableAt"<=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' LIMIT 1`);
      if (!due.rowCount) return;
    }
    assert.fail('Tag recovery failed to drain bounded test backlog');
  };
  await drain();
  const id = randomUUID();
  await prisma.product.create({ data: { id, brandId, name: 'Durable projection fixture', price: 1000, isActive: true, publicationStatus: 'PUBLISHED', tags: ['crash-recovery'] } });
  assert(await job(id)); assert.equal((await bindings(id)).length, 0);
  const contenders = await Promise.all(Array.from({ length: 32 }, () => claimTagJobs(prisma, 'source', 1)));
  const owned = contenders.flat().filter(row => row.entityId === id);
  assert.equal(owned.length, 1);
  await project(owned);
  assert.equal((await bindings(id))[0].tag.normalizedName, 'crash-recovery'); assert.equal(await job(id), undefined);
  cases.push('a committed source survives an absent request projector; 32 concurrent claimants yield one owner and recover one canonical binding');

  await prisma.product.update({ where: { id }, data: { tags: ['generation-one'] } });
  const [old] = await claimTagJobs(prisma, 'source', 1); assert.equal(old.entityId, id);
  await prisma.product.update({ where: { id }, data: { tags: ['generation-two'] } });
  const pending = await job(id); assert.notEqual(pending.generation, old.generation);
  assert.equal(await project([old]), 0);
  assert.equal(await failTagJob(prisma, 'source', old, new Error('stale worker')), 0);
  await acknowledgeTagProjections(prisma, [old], true);
  assert.equal((await job(id)).generation, pending.generation);
  await drain(); assert.deepEqual((await bindings(id)).map(row => row.tag.normalizedName), ['generation-two']);
  cases.push('a new source generation fences stale projection, acknowledgement and failure without overwriting the saved edit');

  await prisma.product.update({ where: { id }, data: { tags: ['lease-recovery'] } });
  const [firstOwner] = await claimTagJobs(prisma, 'source', 1);
  await pool.query(`UPDATE "TagProjectionOutbox" SET "lockExpiresAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'-INTERVAL '1 second' WHERE "entityId"=$1`, [id]);
  const [newOwner] = await claimTagJobs(prisma, 'source', 1);
  assert.notEqual(firstOwner.lockOwner, newOwner.lockOwner); assert.equal(firstOwner.generation, newOwner.generation);
  assert.equal(await project([firstOwner]), 0);
  assert.equal(await failTagJob(prisma, 'source', firstOwner, new Error('old owner')), 0);
  await acknowledgeTagProjections(prisma, [firstOwner], true);
  assert.equal((await job(id)).lockOwner, newOwner.lockOwner);
  await project([newOwner]); assert.equal(await job(id), undefined);
  cases.push('expired lease replacement preserves the new owner against stale success and failure on the same generation');

  await prisma.product.update({ where: { id }, data: { tags: ['busy-source'] } });
  const blocker = await pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('SELECT "_id" FROM "Product" WHERE "_id"=$1 FOR UPDATE', [id]);
    await index.recoverTagProjections();
    const busy = await job(id);
    assert.equal(busy.status, 'FAILED'); assert.equal(busy.attempts, 0); assert.equal(busy.lastError, '55P03');
  } finally { await blocker.query('ROLLBACK'); blocker.release(); }
  await pool.query(`UPDATE "TagProjectionOutbox" SET "availableAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "entityId"=$1`, [id]);
  await drain(); assert.equal((await bindings(id))[0].tag.normalizedName, 'busy-source');
  cases.push('background source locks use NOWAIT; a real blocked row retries without consuming the poison-message attempt budget');

  const future = new Date(Date.now() + 300000);
  await prisma.product.update({ where: { id }, data: { tags: ['scheduled-visible'], publishAt: future } });
  await drain(); assert.equal((await bindings(id)).length, 0);
  const scheduled = await pool.query(`SELECT EXTRACT(EPOCH FROM ("availableAt" AT TIME ZONE 'UTC'))*1000 AS millis FROM "TagProjectionOutbox" WHERE "entityId"=$1`, [id]);
  assert.equal(Number(scheduled.rows[0].millis), future.getTime());
  assert.equal((await claimTagJobs(prisma, 'source', 25)).length, 0);
  await prisma.product.update({ where: { id }, data: { publishAt: new Date(Date.now() - 5000) } });
  await drain(); assert.equal((await bindings(id))[0].tag.normalizedName, 'scheduled-visible');
  cases.push('future publication clears early bindings and retains a due-time instruction; an eligible publication indexes after recovery');

  const designId = randomUUID(), storeId = randomUUID();
  await prisma.user.update({ where: { id: ownerId }, data: { type: 'BRAND' } });
  await prisma.brand.update({ where: { id: brandId }, data: { tags: ['five-sources'], isStoreOpen: true } });
  await prisma.collection.create({ data: { id: designId, ownerId, title: 'Projection design', status: 'PUBLISHED', visibility: 'PUBLIC', tags: ['five-sources'] } });
  await prisma.storeCollection.create({ data: { id: storeId, ownerId, title: 'Projection collection', status: 'PUBLISHED', visibility: 'PUBLIC', tags: ['five-sources'] } });
  await prisma.product.update({ where: { id }, data: { tags: ['five-sources'] } });
  await drain();
  const sourceTag = await prisma.tag.findUniqueOrThrow({ where: { normalizedName: 'five-sources' } });
  assert.equal(sourceTag.usageCount, 5);
  assert.deepEqual((await prisma.tagBinding.findMany({ where: { tagId: sourceTag.id } })).map(row => row.entityType).sort(), ['BRAND','COLLECTION','PRODUCT','STORE_COLLECTION','USER_BRAND'].sort());
  await prisma.collection.update({ where: { id: designId }, data: { visibility: 'PRIVATE' } });
  await prisma.storeCollection.update({ where: { id: storeId }, data: { status: 'DRAFT' } });
  await prisma.brand.update({ where: { id: brandId }, data: { isStoreOpen: false } });
  await prisma.user.update({ where: { id: ownerId }, data: { type: 'REGULAR' } });
  await drain();
  assert.equal((await prisma.tag.findUniqueOrThrow({ where: { id: sourceTag.id } })).usageCount, 1);
  cases.push('all five source types enqueue and recover; private design, draft store collection, closed store and regular-user changes remove only their bindings');

  await prisma.product.delete({ where: { id } });
  assert.equal(await prisma.tagBinding.count({ where: { entityId: id } }), 0);
  assert.equal((await prisma.tag.findUniqueOrThrow({ where: { id: sourceTag.id } })).usageCount, 1);
  await drain();
  assert.equal((await prisma.tag.findUniqueOrThrow({ where: { id: sourceTag.id } })).usageCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM "TagUsageOutbox" WHERE "tagId"=$1', [sourceTag.id])).rowCount, 0);
  cases.push('actual typed-FK cascade deletion leaves a durable usage repair; recovery resets the orphaned tag count to zero');

  const poisonId = randomUUID(), healthyId = randomUUID(), cycleA = randomUUID(), cycleB = randomUUID();
  await prisma.tag.createMany({ data: [{ id: cycleA, normalizedName: 'cycle-a', displayName: 'Cycle A' }, { id: cycleB, normalizedName: 'cycle-b', displayName: 'Cycle B', aliasOfTagId: cycleA }] });
  await prisma.tag.update({ where: { id: cycleA }, data: { aliasOfTagId: cycleB } });
  await prisma.product.createMany({ data: [{ id: poisonId, tags: ['cycle-a'] }, { id: healthyId, tags: ['healthy-neighbour'] }].map(row => ({ ...row, brandId, name: 'Poison isolation fixture', price: 1000, isActive: true, publicationStatus: 'PUBLISHED' })) });
  await index.recoverTagProjections();
  assert.equal((await job(poisonId)).status, 'FAILED');
  assert.equal(await job(healthyId), undefined); assert.equal((await bindings(healthyId)).length, 1);
  await pool.query(`UPDATE "TagProjectionOutbox" SET attempts=7,"availableAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' WHERE "entityId"=$1`, [poisonId]);
  await index.recoverTagProjections(); assert.equal((await job(poisonId)).attempts, 8); assert.match((await job(poisonId)).lastError, /^DLQ_EXHAUSTED:/);
  assert.equal((await claimTagJobs(prisma, 'source', 25)).length, 0);
  await prisma.product.update({ where: { id: poisonId }, data: { tags: ['repaired-source'] } });
  await drain(); assert.equal((await bindings(poisonId))[0].tag.normalizedName, 'repaired-source');
  cases.push('one cyclic alias cannot poison healthy neighbours; eighth failure is quarantined and a source edit safely resets the generation and retry budget');

  await prisma.product.update({ where: { id: healthyId }, data: { tags: ['expired-final'] } });
  await claimTagJobs(prisma, 'source', 25);
  await pool.query(`UPDATE "TagProjectionOutbox" SET attempts=8,"lockExpiresAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'-INTERVAL '1 second' WHERE "entityId"=$1`, [healthyId]);
  await index.recoverTagProjections();
  assert.equal((await job(healthyId)).status, 'FAILED'); assert.match((await job(healthyId)).lastError, /^DLQ_EXHAUSTED:/);
  cases.push('a worker lost on its final attempt becomes an explicit exhausted failure instead of remaining stuck PROCESSING');

  const rollbackId = randomUUID();
  await pool.query(`ALTER TABLE "TagProjectionOutbox" ADD CONSTRAINT projection_failure_fixture CHECK ("entityId"<>'${rollbackId}'::uuid)`);
  await assert.rejects(prisma.product.create({ data: { id: rollbackId, brandId, name: 'Rollback fixture', price: 1000, tags: ['never-partial'] } }));
  assert.equal(await prisma.product.findUnique({ where: { id: rollbackId } }), null);
  await pool.query('ALTER TABLE "TagProjectionOutbox" DROP CONSTRAINT projection_failure_fixture');
  cases.push('a real outbox CHECK failure rolls back its source write atomically; no source can silently commit without a recovery instruction');

  const usageTag = randomUUID();
  await prisma.tag.create({ data: {id: usageTag, normalizedName: 'usage-owner', displayName: 'Usage owner'} });
  await prisma.tagBinding.create({data: {id: randomUUID(), tagId: usageTag, entityType: 'PRODUCT', entityId: healthyId}});
  const usageClaims = (await Promise.all(Array.from({length: 32}, () => claimTagJobs(prisma, 'usage', 100)))).flat().filter(row => row.tagId === usageTag);
  assert.equal(usageClaims.length, 1);
  const oldUsage = usageClaims[0];
  await pool.query(`UPDATE "TagUsageOutbox" SET "lockExpiresAt"=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'-INTERVAL '1 second' WHERE "tagId"=$1`, [usageTag]);
  const newUsages = await claimTagJobs(prisma, 'usage', 100), newUsage = newUsages.find(row => row.tagId === usageTag);
  assert(newUsage); assert.notEqual(oldUsage.lockOwner, newUsage.lockOwner);
  await index.projectUsageJobs([oldUsage]);
  assert.equal((await prisma.tag.findUniqueOrThrow({where: {id: usageTag}})).usageCount, 0);
  assert.equal(await failTagJob(prisma, 'usage', oldUsage, new Error('stale usage owner')), 0);
  await index.projectUsageJobs([newUsage]);
  assert.equal((await prisma.tag.findUniqueOrThrow({where: {id: usageTag}})).usageCount, 1);
  assert.equal((await pool.query('SELECT 1 FROM "TagUsageOutbox" WHERE "tagId"=$1', [usageTag])).rowCount, 0);
  cases.push('32 usage claimants yield one owner; an expired owner cannot update counters or fail a replacement claim, while the current owner counts and acknowledges atomically');

  const tags = new (require('../src/tags/tags.service').TagsService)(prisma, index);
  const inverses = await Promise.allSettled([tags.mergeTags('inverse-a', 'inverse-b'), tags.mergeTags('inverse-b', 'inverse-a')]);
  assert.equal(inverses.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(inverses.filter(result => result.status === 'rejected').length, 1);
  const merged = await prisma.tag.findMany({where: {normalizedName: {in: ['inverse-a', 'inverse-b']}}});
  assert.equal(merged.filter(row => row.aliasOfTagId).length, 1);
  const alias = merged.find(row => row.aliasOfTagId);
  await tags.mergeTags('canonical-third', alias.normalizedName);
  assert.equal((await prisma.tag.findUniqueOrThrow({where: {normalizedName: 'canonical-third'}})).aliasOfTagId, alias.aliasOfTagId);
  cases.push('concurrent inverse admin merges produce one valid alias and one refusal; merges into aliases resolve to the canonical target without creating chains');

  const timedId = randomUUID(), dueAt = new Date(Date.now()+1500);
  await prisma.product.create({data: {id: timedId, brandId, name: 'Clock-only publication', price: 1000, isActive: true, publicationStatus: 'PUBLISHED', tags: ['clock-only'], publishAt: dueAt}});
  await index.recoverTagProjections();
  assert.equal((await bindings(timedId)).length, 0);
  const deadline = Date.now()+5000;
  for (;;) {
    const ready = await pool.query(`SELECT "availableAt"<=CURRENT_TIMESTAMP AT TIME ZONE 'UTC' AS due FROM "TagProjectionOutbox" WHERE "entityId"=$1`, [timedId]);
    if (ready.rows[0]?.due) break;
    assert(Date.now()<deadline, 'Scheduled instruction did not become due');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  await index.recoverTagProjections();
  assert.equal((await bindings(timedId))[0].tag.normalizedName, 'clock-only');
  cases.push('a scheduled product becomes tag-indexed when the database clock passes its publication time without another source edit');

  const fkTag = await prisma.tag.create({data: {id: randomUUID(), normalizedName: 'fk-compatible', displayName: 'FK compatible', status: 'APPROVED'}});
  const fkProduct = randomUUID();
  await prisma.product.create({data: {id: fkProduct, brandId, name: 'Foreign-key lock compatibility', price: 1000, isActive: true, publicationStatus: 'PUBLISHED', tags: ['fk-compatible']}});
  const mergeWriter = await pool.connect(); let projecting;
  try {
    await mergeWriter.query('BEGIN');
    await mergeWriter.query('SELECT "_id" FROM "Tag" WHERE "_id"=$1 FOR UPDATE', [fkTag.id]);
    await mergeWriter.query("SET LOCAL lock_timeout='1s'");
    projecting = index.syncEntityTags('PRODUCT', fkProduct, [], ['fk-compatible']); projecting.catch(() => {});
    const deadline = Date.now()+5000;
    for (;;) {
      const blocked = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%Tag%'`);
      if (blocked.rowCount) break;
      assert(Date.now()<deadline, 'Projector did not reach the held tag lock');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await mergeWriter.query('INSERT INTO "TagBinding"("_id","tagId","entityType","entityId","updatedAt") VALUES($1,$2,\'PRODUCT\',$3,clock_timestamp() AT TIME ZONE \'UTC\')', [randomUUID(), fkTag.id, fkProduct]);
    await mergeWriter.query('COMMIT');
  } finally {await mergeWriter.query('ROLLBACK'); mergeWriter.release();}
  await projecting;
  assert.equal(await prisma.tagBinding.count({where: {entityId: fkProduct, tagId: fkTag.id}}), 1);
  assert.equal((await prisma.tag.findUniqueOrThrow({where: {id: fkTag.id}})).usageCount, 1);
  cases.push('a real typed-FK binding insert completes while its source projector waits for a held tag; NO KEY UPDATE avoids the source/tag lock inversion and the projector retains one binding');
  for (let n=0; n<20; n++) await tags.mergeTags(`bounded-alias-${n}`, `bounded-alias-${n+1}`);
  const finalRoot = await prisma.tag.findUniqueOrThrow({where: {normalizedName: 'bounded-alias-20'}});
  const previousRoots = await prisma.tag.findMany({where: {normalizedName: {in: Array.from({length:20},(_,n)=>`bounded-alias-${n}`)}}});
  assert.equal(previousRoots.length, 20);
  assert(previousRoots.every(row => row.aliasOfTagId === finalRoot.id));
  await prisma.product.update({where: {id: fkProduct}, data: {tags: ['bounded-alias-0']}});
  await index.syncEntityTags('PRODUCT', fkProduct, [], []);
  assert.equal((await bindings(fkProduct))[0].tagId, finalRoot.id);
  cases.push('twenty successive canonical merges keep inbound aliases pointed at the current root instead of exceeding the projection depth limit');

  assert.deepEqual(await readTagProjectionJobs(prisma, []), []);
};
