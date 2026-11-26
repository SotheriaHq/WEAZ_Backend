const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

async function checkDiscoverySchema(db, connectionString, fixture) {
  const { user, products } = fixture;
  const reject = (operation, code = '23514') =>
    assert.rejects(operation, (error) => error.code === code);
  const synonym = async (term, canonical) => {
    await db.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    try {
      await db.query(
        `INSERT INTO "SearchSynonym" (id,kind,term,canonical,"updatedAt")
        VALUES ($1,'TERM',$2,$3,statement_timestamp())`,
        [randomUUID(), term, canonical],
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    }
  };
  await reject(() =>
    db.query(
      `INSERT INTO "SearchSynonym" (id,kind,term,canonical,"updatedAt")
    VALUES ($1,'TERM','unsafe','transaction',statement_timestamp())`,
      [randomUUID()],
    ),
  );
  await synonym('  ＧＯＷＮ ', ' Dress ');
  const normalized = (
    await db.query('SELECT term,canonical FROM "SearchSynonym"')
  ).rows[0];
  assert.deepEqual(normalized, { term: 'gown', canonical: 'dress' });
  await reject(() => synonym('GOWN', 'frock'), '23505');
  await reject(() => synonym('dress', 'gown'));
  await synonym('dress', 'frock');
  await reject(() => synonym('frock', 'gown'));
  await reject(() => synonym('self', 'SELF'));

  const a = new Client({ connectionString }),
    b = new Client({ connectionString });
  await a.connect();
  await b.connect();
  try {
    await a.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await b.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await a.query(
      `INSERT INTO "SearchSynonym" (id,kind,term,canonical,"updatedAt")
      VALUES ($1,'TERM','cycle-a','cycle-b',statement_timestamp())`,
      [randomUUID()],
    );
    await b.query(
      `INSERT INTO "SearchSynonym" (id,kind,term,canonical,"updatedAt")
      VALUES ($1,'TERM','cycle-b','cycle-a',statement_timestamp())`,
      [randomUUID()],
    );
    const commits = await Promise.allSettled([
      a.query('COMMIT'),
      b.query('COMMIT'),
    ]);
    assert.equal(
      commits.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      commits.find((result) => result.status === 'rejected').reason.code,
      '40001',
    );
    assert.equal(
      (
        await db.query(
          `SELECT count(*)::int AS n FROM "SearchSynonym" WHERE term IN ('cycle-a','cycle-b')`,
        )
      ).rows[0].n,
      1,
    );
  } finally {
    await a.query('ROLLBACK');
    await b.query('ROLLBACK');
    await a.end();
    await b.end();
  }
  console.log(
    'PASS normalized synonyms, duplicate/cycle rejection and concurrent cycle serialization',
  );

  const chips = [{ label: 'Casual pieces', filters: { audience: 'UNISEX' } }];
  const chip = (key, surface, start, end, status = 'ACTIVE', value = chips) =>
    db.query(
      `
    INSERT INTO "MarketChipSet" (id,key,surface,label,chips,"startsAt","endsAt",status,"updatedAt")
    VALUES ($1,$2,$3,'Fixture chips',$4,$5,$6,$7,statement_timestamp())`,
      [randomUUID(), key, surface, JSON.stringify(value), start, end, status],
    );
  await chip(
    'first',
    'MARKET_HOME',
    '2026-11-15T12:00:00Z',
    '2026-11-15T13:00:00Z',
  );
  await chip(
    'adjacent',
    'MARKET_HOME',
    '2026-11-15T13:00:00Z',
    '2026-11-15T14:00:00Z',
  );
  await chip('other-surface', 'DESIGN_FEED', null, null);
  await reject(
    () =>
      chip(
        'overlap',
        'MARKET_HOME',
        '2026-11-15T12:30:00Z',
        '2026-11-15T13:30:00Z',
      ),
    '23P01',
  );
  await chip('draft', 'MARKET_HOME', null, null, 'DRAFT');
  await reject(
    () =>
      db.query(`UPDATE "MarketChipSet" SET status='ACTIVE' WHERE key='draft'`),
    '23P01',
  );
  await reject(() =>
    chip(
      'backwards',
      'MARKET_HOME',
      '2026-11-15T13:00:00Z',
      '2026-11-15T12:00:00Z',
    ),
  );
  await reject(() =>
    chip(
      'too-many',
      'MARKET_HOME',
      null,
      null,
      'DRAFT',
      Array(9).fill(chips[0]),
    ),
  );
  await reject(() =>
    chip('empty-active', 'MARKET_HOME', null, null, 'ACTIVE', []),
  );
  const chipA = new Client({ connectionString }),
    chipB = new Client({ connectionString });
  await chipA.connect();
  await chipB.connect();
  try {
    await chipA.query('BEGIN');
    await chipB.query('BEGIN');
    const sql = `INSERT INTO "MarketChipSet" (id,key,surface,label,chips,"startsAt","endsAt",status,"updatedAt")
      VALUES ($1,$2,'MARKET_HOME','Concurrent fixture',$3,$4,$5,'ACTIVE',statement_timestamp())`;
    await chipA.query(sql, [
      randomUUID(),
      'concurrent-a',
      JSON.stringify(chips),
      '2026-11-18T12:00:00Z',
      '2026-11-18T14:00:00Z',
    ]);
    const pending = chipB
      .query(sql, [
        randomUUID(),
        'concurrent-b',
        JSON.stringify(chips),
        '2026-11-18T13:00:00Z',
        '2026-11-18T15:00:00Z',
      ])
      .then(
        () => null,
        (error) => error.code,
      );
    await chipA.query('COMMIT');
    assert.equal(await pending, '23P01');
  } finally {
    await chipA.query('ROLLBACK');
    await chipB.query('ROLLBACK');
    await chipA.end();
    await chipB.end();
  }
  console.log(
    'PASS chip schedules: adjacency, separate surfaces, malformed sets and concurrent overlap',
  );

  const addPair = (target) =>
    db.query(
      `INSERT INTO "ProductComplement" ("productId","complementId","createdById","updatedAt")
    VALUES ($1,$2,$3,statement_timestamp())`,
      [products[0], target, user],
    );
  await reject(() => addPair(products[0]));
  await addPair(products[1]);
  await reject(() => addPair(products[1]), '23505');
  assert.equal(
    (await db.query('SELECT status FROM "ProductComplement"')).rows[0].status,
    'PENDING',
  );
  await reject(() =>
    db.query(`UPDATE "ProductComplement" SET status='APPROVED'`),
  );
  await db.query(
    `UPDATE "ProductComplement" SET status='APPROVED',"reviewedById"=$1,"reviewedAt"=statement_timestamp()`,
    [user],
  );
  console.log(
    'PASS complement pairs default pending; duplicates, self-links and incomplete approvals are rejected',
  );

  await db.query(
    `INSERT INTO "UserProfile" ("_id","userId","firstName","lastName","updatedAt")
    VALUES ($1,$2,'Fixture','Shopper',statement_timestamp())`,
    [randomUUID(), user],
  );
  const prefs = (
    await db.query(
      'SELECT "marketPersonalization","marketRegionalOptIn" FROM "UserProfile" WHERE "userId"=$1',
      [user],
    )
  ).rows[0];
  assert.deepEqual(prefs, {
    marketPersonalization: true,
    marketRegionalOptIn: false,
  });
  const cartId = randomUUID();
  await db.query(
    `INSERT INTO "CartItem" ("_id","userId","productId","updatedAt")
    VALUES ($1,$2,$3,statement_timestamp())`,
    [cartId, user, products[0]],
  );
  await reject(() =>
    db.query('UPDATE "CartItem" SET "sourcePosition"=0 WHERE "_id"=$1', [
      cartId,
    ]),
  );
  await db.query(
    `UPDATE "CartItem" SET "sourceSection"='fresh-drops',"sourcePosition"=0 WHERE "_id"=$1`,
    [cartId],
  );
  await reject(() =>
    db.query(`UPDATE "CartItem" SET "sourcePosition"=-1 WHERE "_id"=$1`, [
      cartId,
    ]),
  );
  await reject(() =>
    db.query(
      `UPDATE "CartItem" SET "sourceSection"='private@example.test' WHERE "_id"=$1`,
      [cartId],
    ),
  );
  console.log(
    'PASS optional legacy attribution and inert preference defaults; malformed attribution is rejected',
  );
}

module.exports = { checkDiscoverySchema };
