import { randomUUID } from 'crypto';
import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MessagingService } from './messaging.service';
import { MessagingPolicyService } from './messaging-policy.service';
import { MessagingQueryService } from './messaging-query.service';
import { MessagingSideEffectsService } from './messaging-side-effects.service';

jest.mock('src/upload/upload.service', () => ({ UploadService: class {} }));
jest.mock('src/custom-orders/custom-orders.service', () => ({ CustomOrdersService: class {} }));

const { Client, Pool } = require('pg');
const integration =
  process.env.RUN_MESSAGING_PG_TESTS === '1' ? describe : describe.skip;

// Real PostgreSQL runs the production locks, receipt JOINs and lease claim SQL.
// The narrow adapter supplies only the Prisma operations used by these paths;
// authorization policy and attachment processing have their separate unit suites.
integration(
  'Messaging concurrency on an isolated local PostgreSQL database',
  () => {
    let admin: any;
    let pool: any;
    let database: string;
    let created = false;
    let service: MessagingService;
    let query: MessagingQueryService;
    let worker: MessagingSideEffectsService;
    let prisma: any;
    let effects: any;
    let queue: any;
    let threadId: string;
    let buyer: string;
    let owner: string;
    let failOutboxInsert = false;
    let failOutboxAcknowledgement = false;

    const raw =
      (client: any, rows: boolean) =>
      async (
        input: Prisma.Sql | TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const sql = Array.isArray(input)
          ? Prisma.sql(input as TemplateStringsArray, ...values)
          : (input as Prisma.Sql);
        const result = await client.query(sql.text, sql.values);
        return rows ? result.rows : result.rowCount;
      };

    const assignments = (data: Record<string, unknown>, offset = 0) => {
      const entries = Object.entries(data);
      const allowed = new Set([
        'lastMessageId',
        'lastMessageAt',
        'lastVisibleMessageAt',
        'lastMessagePreview',
        'lastSenderUserId',
        'status',
        'processedAt',
        'lastError',
        'processingLeaseToken',
        'processingLeaseUntil',
        'availableAt',
      ]);
      for (const [key] of entries)
        if (!allowed.has(key))
          throw new Error(`Unsupported fixture field ${key}`);
      return {
        text: entries
          .map(([key], index) => `"${key}"=$${offset + index + 1}`)
          .join(','),
        values: entries.map(([, value]) => value),
      };
    };

    const adapter = (client: any): any => {
      const thread = async ({ where }: any) => {
        const row = (
          await client.query('SELECT * FROM "MessageThread" WHERE "id"=$1', [
            where.id,
          ])
        ).rows[0];
        if (!row) return null;
        return {
          ...row,
          participants: (
            await client.query(
              'SELECT * FROM "MessageThreadParticipant" WHERE "threadId"=$1',
              [where.id],
            )
          ).rows,
        };
      };
      const message = (row: any) =>
        row
          ? {
              ...row,
              attachments: [],
              sender: {
                id: row.senderUserId,
                firstName: 'Shopper',
                lastName: 'Example',
                username: 'shopper',
                profileImage: null,
              },
            }
          : null;
      return {
        $queryRaw: raw(client, true),
        $executeRaw: raw(client, false),
        messageThread: {
          findFirst: thread,
          findUnique: thread,
          update: async ({ where, data }: any) => {
            const set = assignments(data);
            await client.query(
              `UPDATE "MessageThread" SET ${set.text} WHERE "id"=$${set.values.length + 1}`,
              [...set.values, where.id],
            );
            return thread({ where });
          },
        },
        message: {
          findFirst: async ({ where }: any) => {
            const keys = [
              'id',
              'threadId',
              'senderUserId',
              'clientMessageId',
            ].filter((key) => where[key] !== undefined);
            return message(
              (
                await client.query(
                  `SELECT * FROM "Message" WHERE ${keys.map((key, i) => `"${key}"=$${i + 1}`).join(' AND ')} ORDER BY "createdAt" DESC,"id" DESC LIMIT 1`,
                  keys.map((key) => where[key]),
                )
              ).rows[0],
            );
          },
          create: async ({ data }: any) =>
            message(
              (
                await client.query(
                  `INSERT INTO "Message"("id","threadId","senderUserId","senderRole","kind","clientMessageId","createdAt","bodyText") VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
                  [
                    randomUUID(),
                    data.threadId,
                    data.senderUserId,
                    data.senderRole,
                    data.kind,
                    data.clientMessageId,
                    data.createdAt,
                    data.bodyText,
                  ],
                )
              ).rows[0],
            ),
        },
        messageThreadParticipant: {
          findUnique: async ({ where }: any) => {
            const key = where.threadId_userId;
            return (
              (
                await client.query(
                  'SELECT * FROM "MessageThreadParticipant" WHERE "threadId"=$1 AND "userId"=$2',
                  [key.threadId, key.userId],
                )
              ).rows[0] ?? null
            );
          },
          upsert: async ({ create, update }: any) => {
            const updateWatermark = Object.prototype.hasOwnProperty.call(
              update,
              'lastReadAt',
            );
            await client.query(
              `INSERT INTO "MessageThreadParticipant"("threadId","userId","role","lastReadAt","lastReadMessageId") VALUES($1,$2,$3,$4,$5)
            ON CONFLICT ("threadId","userId") DO UPDATE SET "role"=EXCLUDED."role"${updateWatermark ? ',"lastReadAt"=EXCLUDED."lastReadAt","lastReadMessageId"=EXCLUDED."lastReadMessageId"' : ''}`,
              [
                create.threadId,
                create.userId,
                create.role,
                create.lastReadAt,
                create.lastReadMessageId,
              ],
            );
          },
        },
        messageNotificationOutbox: {
          createMany: async ({ data }: any) => {
            if (failOutboxInsert) {
              failOutboxInsert = false;
              throw new Error('Injected outbox insertion failure');
            }
            const values: unknown[] = [];
            const tuples = data.map((row: any) => {
              const offset = values.length;
              values.push(
                row.threadId,
                row.messageId,
                row.recipientId,
                row.notificationType,
                row.payloadJson,
              );
              return `(${Array.from({ length: 5 }, (_, i) => `$${offset + i + 1}`).join(',')})`;
            });
            return client.query(
              `INSERT INTO "MessageNotificationOutbox"("threadId","messageId","recipientId","notificationType","payloadJson") VALUES ${tuples.join(',')}`,
              values,
            );
          },
          updateMany: async ({ where, data }: any) => {
            if (failOutboxAcknowledgement) {
              failOutboxAcknowledgement = false;
              throw new Error('Injected acknowledgement failure');
            }
            const set = assignments(data);
            const result = await client.query(
              `UPDATE "MessageNotificationOutbox" SET ${set.text} WHERE "id"=$${set.values.length + 1} AND "status"=$${set.values.length + 2} AND "processingLeaseToken"=$${set.values.length + 3}`,
              [
                ...set.values,
                where.id,
                where.status,
                where.processingLeaseToken,
              ],
            );
            return { count: result.rowCount };
          },
        },
      };
    };

    beforeAll(async () => {
      require('dotenv').config({ quiet: true });
      const source = new URL(process.env.DATABASE_URL ?? '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname))
        throw new Error('Messaging integration requires local PostgreSQL');
      database = `wiez_messaging_race_${Date.now()}`;
      const adminUrl = new URL(source);
      adminUrl.pathname = '/postgres';
      const testUrl = new URL(source);
      testUrl.pathname = `/${database}`;
      testUrl.searchParams.set('options', '-c timezone=Africa/Lagos');
      admin = new Client({ connectionString: adminUrl.toString() });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${database}"`);
      created = true;
      pool = new Pool({
        connectionString: testUrl.toString(),
        max: 8,
        statement_timeout: 10000,
      });
      await pool.query(`
      CREATE TABLE "MessageThread"("id" uuid PRIMARY KEY,"contextType" text DEFAULT 'DIRECT',"conversationType" text DEFAULT 'BUYER_BRAND',"pairKey" text DEFAULT 'pair',"orderId" uuid,"customOrderId" uuid,"brandId" uuid,"buyerId" uuid,"buyerUserId" uuid,"status" text DEFAULT 'OPEN',"lastMessageId" uuid,"lastMessageAt" timestamp(3),"lastVisibleMessageAt" timestamp(3),"lastMessagePreview" text,"lastSenderUserId" uuid);
      CREATE TABLE "MessageThreadParticipant"("threadId" uuid REFERENCES "MessageThread","userId" uuid,"role" text,"lastReadAt" timestamp(3),"lastReadMessageId" uuid,"archivedAt" timestamp(3),PRIMARY KEY("threadId","userId"));
      CREATE TABLE "Message"("id" uuid PRIMARY KEY,"threadId" uuid REFERENCES "MessageThread","senderUserId" uuid,"senderRole" text,"kind" text,"visibilityState" text DEFAULT 'VISIBLE',"clientMessageId" text,"createdAt" timestamp(3),"bodyText" text,UNIQUE("threadId","senderUserId","clientMessageId"));
      CREATE TABLE "MessageDeliveryReceipt"("id" uuid PRIMARY KEY,"messageId" uuid REFERENCES "Message","recipientId" uuid,"deliveredAt" timestamp(3),"readAt" timestamp(3),"createdAt" timestamp(3),UNIQUE("messageId","recipientId"));
      CREATE TABLE "MessageNotificationOutbox"("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),"threadId" uuid REFERENCES "MessageThread","messageId" uuid REFERENCES "Message","recipientId" uuid,"notificationType" text,"payloadJson" jsonb,"status" text DEFAULT 'PENDING',"attempts" integer DEFAULT 0,"availableAt" timestamp(3) DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),"createdAt" timestamp(3) DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),"updatedAt" timestamp(3) DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'),"processedAt" timestamp(3),"lastError" text,"processingLeaseToken" uuid,"processingLeaseUntil" timestamp(3),UNIQUE("messageId","recipientId","notificationType"));
    `);
      prisma = {
        ...adapter(pool),
        $transaction: async (work: (tx: any) => Promise<unknown>) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const result = await work(adapter(client));
            await client.query('COMMIT');
            return result;
          } catch (error) {
            await client.query('ROLLBACK');
            if ((error as any).code === '23505') (error as any).code = 'P2002';
            throw error;
          } finally {
            client.release();
          }
        },
      };
      query = new MessagingQueryService(prisma);
      jest
        .spyOn(query, 'getMessagingPrivacy')
        .mockImplementation(
          async (ids) =>
            new Map(
              ids.map((id) => [
                id,
                { readReceipts: true, deliveryReceipts: true },
              ]),
            ),
        );
      effects = {
        dispatchMessageOutboxForMessage: jest.fn().mockResolvedValue(undefined),
        emitMessageCreated: jest.fn(),
        emitThreadInvalidation: jest.fn(),
        emitMessageRead: jest.fn(),
        getConnectedRecipientIds: jest.fn().mockResolvedValue([]),
      };
      const authorize = async (actorId: string, target: string) => {
        if (
          !(
            await pool.query(
              'SELECT 1 FROM "MessageThreadParticipant" WHERE "threadId"=$1 AND "userId"=$2',
              [target, actorId],
            )
          ).rowCount
        )
          throw new ForbiddenException();
      };
      service = new MessagingService(
        prisma,
        {} as any,
        { resolveValidatedAttachments: async () => [] } as any,
        {
          assertCanSendMessage: authorize,
          assertCanReadThread: authorize,
        } as any,
        new MessagingPolicyService(),
        query,
        effects,
        {} as any,
        {} as any,
      );
      queue = { enqueueFanout: jest.fn().mockResolvedValue(undefined) };
      worker = new MessagingSideEffectsService(
        prisma,
        queue,
        {} as any,
        {} as any,
      );
    }, 30000);

    beforeEach(async () => {
      await pool.query(
        'TRUNCATE "MessageThread","MessageThreadParticipant","Message","MessageDeliveryReceipt","MessageNotificationOutbox" CASCADE',
      );
      threadId = randomUUID();
      buyer = randomUUID();
      owner = randomUUID();
      failOutboxInsert = false;
      failOutboxAcknowledgement = false;
      queue.enqueueFanout.mockClear();
      effects.emitMessageCreated.mockClear();
      await pool.query(
        'INSERT INTO "MessageThread"("id","brandId","buyerId","buyerUserId") VALUES($1,$2,$3,$3)',
        [threadId, randomUUID(), buyer],
      );
      await pool.query(
        `INSERT INTO "MessageThreadParticipant"("threadId","userId","role") VALUES($1,$2,'BUYER'),($1,$3,'BRAND_OWNER')`,
        [threadId, buyer, owner],
      );
    });

    afterAll(async () => {
      if (pool) await pool.end();
      if (created && /^wiez_messaging_race_\d+$/.test(database))
        await admin.query(`DROP DATABASE "${database}"`);
      if (admin) await admin.end();
    });

    const send = (clientMessageId = randomUUID()) =>
      service.sendMessageToThread(
        buyer,
        threadId,
        { clientMessageId, bodyText: 'A fashion question' },
        clientMessageId,
      );

    it('concurrent retries persist one message, one recipient outbox and one realtime event', async () => {
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 12 }, () => send(key)),
      );
      expect(results.filter((result) => !result.replay)).toHaveLength(1);
      expect((await pool.query('SELECT 1 FROM "Message"')).rowCount).toBe(1);
      expect(
        (await pool.query('SELECT 1 FROM "MessageNotificationOutbox"'))
          .rowCount,
      ).toBe(1);
      expect(effects.emitMessageCreated).toHaveBeenCalledTimes(1);
    }, 30000);

    it('concurrent distinct sends keep timestamps, last-message summary and sender watermark ordered', async () => {
      await Promise.all(Array.from({ length: 16 }, () => send()));
      const messages = (
        await pool.query('SELECT * FROM "Message" ORDER BY "createdAt"')
      ).rows;
      expect(
        new Set(messages.map((row: any) => row.createdAt.getTime())).size,
      ).toBe(16);
      const last = messages[messages.length - 1];
      expect(
        (await pool.query('SELECT "lastMessageId" FROM "MessageThread"'))
          .rows[0].lastMessageId,
      ).toBe(last.id);
      expect(
        (
          await pool.query(
            'SELECT "lastReadMessageId" FROM "MessageThreadParticipant" WHERE "userId"=$1',
            [buyer],
          )
        ).rows[0].lastReadMessageId,
      ).toBe(last.id);
    }, 30000);

    it('rolls back the message, summary and sender watermark if durable outbox insertion fails', async () => {
      failOutboxInsert = true;
      await expect(send()).rejects.toThrow('Injected outbox insertion failure');
      expect((await pool.query('SELECT 1 FROM "Message"')).rowCount).toBe(0);
      expect(
        (await pool.query('SELECT "lastMessageId" FROM "MessageThread"'))
          .rows[0].lastMessageId,
      ).toBeNull();
      expect(
        (
          await pool.query(
            'SELECT "lastReadMessageId" FROM "MessageThreadParticipant" WHERE "userId"=$1',
            [buyer],
          )
        ).rows[0].lastReadMessageId,
      ).toBeNull();
      expect(effects.emitMessageCreated).not.toHaveBeenCalled();
    });

    it('keeps legacy timestamp ties unread until their UUID cursor advances and ignores late older reads', async () => {
      const one = (await send()).message;
      const two = (await send()).message;
      await pool.query('UPDATE "Message" SET "createdAt"=$1 WHERE "id"=$2', [
        one.createdAt,
        two.id,
      ]);
      const [low, high] = [one.id, two.id].sort();
      await service.markThreadReadById(owner, threadId, { upToMessageId: low });
      expect(await query.getUnreadMessageCountForActor(owner)).toBe(1);
      await service.markThreadReadById(owner, threadId, {
        upToMessageId: high,
      });
      await service.markThreadReadById(owner, threadId, { upToMessageId: low });
      expect(await query.getUnreadMessageCountForActor(owner)).toBe(0);
      expect(
        (
          await pool.query(
            'SELECT "lastReadMessageId" FROM "MessageThreadParticipant" WHERE "userId"=$1',
            [owner],
          )
        ).rows[0].lastReadMessageId,
      ).toBe(high);
      expect(
        (
          await pool.query(
            'SELECT 1 FROM "MessageDeliveryReceipt" WHERE "readAt" IS NOT NULL',
          )
        ).rowCount,
      ).toBe(2);
      const receiptInstant = (
        await pool.query(`SELECT MAX("readAt") AT TIME ZONE 'UTC' AS instant FROM "MessageDeliveryReceipt"`)
      ).rows[0].instant;
      expect(Math.abs(Date.now() - receiptInstant.getTime())).toBeLessThan(30000);
      await expect(
        service.markThreadReadById(owner, threadId, {
          upToMessageId: randomUUID(),
        }),
      ).rejects.toThrow('Message not found in this thread');
    });

    it('does not advance an empty thread watermark and rejects an unauthorized sender', async () => {
      await service.markThreadReadById(owner, threadId, {});
      expect(
        (
          await pool.query(
            'SELECT "lastReadAt" FROM "MessageThreadParticipant" WHERE "userId"=$1',
            [owner],
          )
        ).rows[0].lastReadAt,
      ).toBeNull();
      await expect(
        service.sendMessageToThread(
          randomUUID(),
          threadId,
          { clientMessageId: randomUUID(), bodyText: 'Private' },
          'key',
        ),
      ).rejects.toThrow(ForbiddenException);
      expect((await pool.query('SELECT 1 FROM "Message"')).rowCount).toBe(0);
    });

    it('parallel dispatchers claim a recipient once and reclaim an expired worker lease', async () => {
      await send();
      await pool.query(
        `UPDATE "MessageNotificationOutbox" SET "status"='PROCESSING',"processingLeaseToken"=$1,"processingLeaseUntil"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '1 minute'`,
        [randomUUID()],
      );
      await Promise.all([
        worker.dispatchPendingMessageOutbox(),
        worker.dispatchPendingMessageOutbox(),
      ]);
      expect(queue.enqueueFanout).toHaveBeenCalledTimes(1);
      const row = (
        await pool.query('SELECT * FROM "MessageNotificationOutbox"')
      ).rows[0];
      expect(row.status).toBe('COMPLETED');
      expect(row.processingLeaseToken).toBeNull();
      expect(queue.enqueueFanout.mock.calls[0][0].notificationId).toBe(row.id);
    });

    it('retains stable delivery IDs when a worker loses its enqueue acknowledgement', async () => {
      await send();
      failOutboxAcknowledgement = true;
      await worker.dispatchPendingMessageOutbox();
      expect(
        (await pool.query('SELECT "status" FROM "MessageNotificationOutbox"'))
          .rows[0].status,
      ).toBe('FAILED');
      await pool.query(
        `UPDATE "MessageNotificationOutbox" SET "availableAt"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`,
      );
      await worker.dispatchPendingMessageOutbox();
      expect(queue.enqueueFanout.mock.calls[0]).toEqual(
        queue.enqueueFanout.mock.calls[1],
      );
      expect(
        (await pool.query('SELECT "status" FROM "MessageNotificationOutbox"'))
          .rows[0].status,
      ).toBe('COMPLETED');
    });

    it('a stale worker cannot complete a lease that another worker now owns', async () => {
      await send();
      const token = randomUUID();
      await pool.query(
        `UPDATE "MessageNotificationOutbox" SET "status"='PROCESSING',"processingLeaseToken"=$1,"processingLeaseUntil"=(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+INTERVAL '5 minutes'`,
        [token],
      );
      const row = (
        await pool.query('SELECT * FROM "MessageNotificationOutbox"')
      ).rows[0];
      await (worker as any).dispatchClaimedMessageOutbox(row, randomUUID());
      const after = (
        await pool.query('SELECT * FROM "MessageNotificationOutbox"')
      ).rows[0];
      expect(after.status).toBe('PROCESSING');
      expect(after.processingLeaseToken).toBe(token);
    });
  },
);
