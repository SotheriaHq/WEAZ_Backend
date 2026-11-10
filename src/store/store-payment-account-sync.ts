import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from 'crypto';
import type { Prisma, StorePaymentAccountSync } from '@prisma/client';
import type { PrismaService } from 'src/prisma/prisma.service';
import { hasBrandOwnership } from 'src/brands/brand-ownership';
import { assertOperationBrand } from 'src/auth/access/operation-brand-binding';
import {
  getLiveSecurityContext,
  securityRequestContext,
} from 'src/auth/access/security-request-context';
import { withSecurityTransaction } from 'src/auth/access/transactional-enforcement';
import { payoutAccountApprovalState } from 'src/auth/access/payout-account-approval-state';

export type PaymentAccountCommand = {
  brandId: string;
  actorId: string;
  businessName: string;
  bankCode: string;
  bankName: string;
  accountNumber: string;
  primaryContactName: string;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  previous: {
    updatedAt: string;
    subaccountCode: string | null;
    recipientCode: string | null;
    bankFingerprint: string | null;
  } | null;
  devBypass: boolean;
};
type ProviderRecord = Record<string, any>;
type ProviderCall = (
  path: string,
  options?: { method?: string; bodyJson?: Record<string, unknown> },
) => Promise<any>;
const LEASE_MS = 600_000;
export const STORE_PAYMENT_PROVIDER_STATUS = Symbol(
  'store-payment-provider-status',
);
const pending = () =>
  new ConflictException({
    code: 'PAYOUT_ACCOUNT_SYNC_PENDING',
    message:
      'A payout-account update is still being checked. Retry the same update or contact support.',
  });
const sharedBank = () =>
  new ConflictException({
    code: 'PAYOUT_BANK_ALREADY_ASSIGNED',
    message:
      'This payout bank account cannot be assigned to this brand. Use a different bank account.',
  });

/** Stable identity is deliberately separate from rotatable ciphertext keys. */
export class StoreBankIdentity {
  readonly keyId: string;
  private readonly key: Buffer;
  constructor(secret = process.env.STORE_PAYOUT_IDENTITY_SECRET ?? '') {
    this.key = Buffer.from(secret.trim(), 'base64');
    if (
      this.key.length !== 32 ||
      this.key.toString('base64') !== secret.trim()
    ) {
      throw new ServiceUnavailableException(
        'Payout-account identity checks are not configured',
      );
    }
    this.keyId = createHash('sha256')
      .update(this.key)
      .digest('hex')
      .slice(0, 16);
  }
  fingerprint(bankCode: string, accountNumber: string): string {
    if (
      !/^[A-Za-z0-9_-]{1,20}$/.test(bankCode) ||
      !/^\d{10}$/.test(accountNumber)
    ) {
      throw new BadRequestException(
        'Select a bank and enter a valid 10-digit NUBAN',
      );
    }
    return this.digest(['bank-v1', 'NG', 'NGN', bankCode, accountNumber]);
  }
  digest(value: unknown): string {
    return createHmac('sha256', this.key)
      .update('wiez:payout-identity:')
      .update(JSON.stringify(value))
      .digest('hex');
  }
}

/** Durable admission, purpose-specific provider execution, then fenced outcome recording. */
export class StorePaymentAccountSynchronizer {
  private readonly identity: StoreBankIdentity;
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: ProviderCall,
    private readonly encryptionKeys: Buffer[],
    identity?: StoreBankIdentity,
  ) {
    this.identity = identity ?? new StoreBankIdentity();
    if (
      !encryptionKeys.length ||
      encryptionKeys.some((key) => key.length !== 32)
    ) {
      throw new ServiceUnavailableException(
        'Payout-account encryption is not configured',
      );
    }
  }

  private seal(brandId: string, id: string, purpose: string, value: unknown) {
    const iv = randomBytes(12),
      key = this.encryptionKeys[0];
    const cipher = createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: 16,
    });
    cipher.setAAD(
      Buffer.from(`wiez:payout-sync:v1:${brandId}:${id}:${purpose}`),
    );
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      data.toString('base64'),
    ].join('.');
  }
  private unseal<T>(
    row: StorePaymentAccountSync,
    purpose: string,
    value: string,
  ): T {
    const [version, nonce, tag, ciphertext, extra] = value.split('.');
    if (version !== 'v1' || extra !== undefined || value.length > 131_072)
      throw pending();
    for (const key of this.encryptionKeys) {
      try {
        const iv = Buffer.from(nonce, 'base64'),
          authTag = Buffer.from(tag, 'base64'),
          data = Buffer.from(ciphertext, 'base64');
        if (
          iv.length !== 12 ||
          authTag.length !== 16 ||
          !data.length ||
          iv.toString('base64') !== nonce ||
          authTag.toString('base64') !== tag ||
          data.toString('base64') !== ciphertext
        )
          continue;
        const decipher = createDecipheriv('aes-256-gcm', key, iv, {
          authTagLength: 16,
        });
        decipher.setAAD(
          Buffer.from(
            `wiez:payout-sync:v1:${row.brandId}:${row.id}:${purpose}`,
          ),
        );
        decipher.setAuthTag(authTag);
        return JSON.parse(
          Buffer.concat([decipher.update(data), decipher.final()]).toString(
            'utf8',
          ),
        ) as T;
      } catch {
        /* Try the explicitly configured previous encryption key. */
      }
    }
    throw pending();
  }
  private async now(tx: Prisma.TransactionClient): Promise<Date> {
    const [clock] = await tx.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    return clock.now;
  }
  private async lockBrand(tx: Prisma.TransactionClient, brandId: string) {
    await tx.$queryRaw`SELECT "_id" FROM "Brand" WHERE "_id"=${brandId}::uuid FOR UPDATE`;
  }

  private async admit(command: PaymentAccountCommand) {
    assertOperationBrand(command.brandId);
    const context = getLiveSecurityContext();
    if (
      !context ||
      context.operation.actor.id !== command.actorId ||
      context.operation.policy.sensitivity !== 'CRITICAL_CHANGE' ||
      context.operation.policy.scope !== 'BRAND_OWNER' ||
      context.operation.policy.action !== 'brand.payout-account.change' ||
      context.operation.method !== 'PATCH' ||
      context.operation.route !== '/store/payment-account'
    ) {
      throw new ForbiddenException(
        'A live approval for this payout-account change is required',
      );
    }
    if (context.transaction)
      throw new ConflictException(
        'Admit the payout-account command before entering another transaction',
      );
    const fingerprint = this.identity.fingerprint(
      command.bankCode,
      command.accountNumber,
    );
    const digest = this.identity.digest(command);
    return withSecurityTransaction(this.prisma, async (tx) => {
      await this.lockBrand(tx, command.brandId);
      const brand = await tx.brand.findUnique({
        where: { id: command.brandId },
        select: { id: true, ownerId: true },
      });
      if (!brand || !(await hasBrandOwnership(tx, command.actorId, brand)))
        throw new ForbiddenException('Brand ownership is required');
      if (
        JSON.stringify(context.operation.serverState) !==
        JSON.stringify(await payoutAccountApprovalState(tx, command.brandId))
      ) {
        throw new ConflictException({
          code: 'SECURITY_RESOURCE_CHANGED',
          message: 'The payout account changed. Verify the update again.',
        });
      }
      {
        const body = context.operation.body as {
          bankCode?: unknown;
          accountNumber?: unknown;
        } | null;
        if (
          (body?.bankCode &&
            String(body.bankCode).trim() !== command.bankCode) ||
          (body?.accountNumber &&
            String(body.accountNumber).trim() !== command.accountNumber)
        )
          throw new ForbiddenException(
            'The bank details differ from the approved action',
          );
      }
      // One indexed gate avoids scanning every brand on every setup request.
      // Shared readers can admit concurrently; preparation takes the exclusive lock.
      const [identityState] = await tx.$queryRaw<
        Array<{ keyId: string | null; ready: boolean }>
      >`
        SELECT "keyId","ready" FROM "StorePayoutIdentityState" WHERE "id"='payout-bank-v1' FOR SHARE`;
      if (!identityState?.ready || identityState.keyId !== this.identity.keyId)
        throw new ServiceUnavailableException({
          code: 'PAYOUT_BANK_CLAIMS_NOT_READY',
          message:
            'Payout-account checks need maintenance. Please contact support.',
        });
      const current = await tx.storePaymentAccount.findUnique({
        where: { brandId: command.brandId },
      });
      if (
        (current?.updatedAt.toISOString() ?? null) !==
        (command.previous?.updatedAt ?? null)
      )
        throw pending();
      const active = await tx.storePaymentAccountSync.findFirst({
        where: { brandId: command.brandId, finishedAt: null },
      });
      const now = await this.now(tx),
        leaseToken = randomUUID(),
        leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
      if (
        active &&
        (active.commandDigest !== digest ||
          (active.leaseExpiresAt && active.leaseExpiresAt > now))
      )
        throw pending();
      const retiring = await tx.storePayoutRecipientRetirement.findFirst({
        where: { bankFingerprint: fingerprint, retiredAt: null },
        select: { recipientCode: true },
      });
      if (retiring) throw pending();
      await tx.storePayoutBankClaim.createMany({
        data: {
          fingerprint,
          keyId: this.identity.keyId,
          brandId: command.brandId,
        },
        skipDuplicates: true,
      });
      const claim = await tx.storePayoutBankClaim.findUniqueOrThrow({
        where: { fingerprint },
      });
      if (claim.brandId !== command.brandId) throw sharedBank();
      if (active)
        return tx.storePaymentAccountSync.update({
          where: { id: active.id },
          data: { leaseToken, leaseExpiresAt, failureCode: null },
        });
      const id = randomUUID();
      return tx.storePaymentAccountSync.create({
        data: {
          id,
          brandId: command.brandId,
          actorId: command.actorId,
          bankFingerprint: fingerprint,
          commandDigest: digest,
          commandEncrypted: this.seal(command.brandId, id, 'command', command),
          operationDigest: context.operation.operationDigest,
          leaseToken,
          leaseExpiresAt,
        },
      });
    });
  }

  /** Only the already admitted immutable command may survive the initiating HTTP authority. */
  private fenced<T>(
    row: StorePaymentAccountSync,
    work: (
      tx: Prisma.TransactionClient,
      current: StorePaymentAccountSync,
      now: Date,
    ) => Promise<T>,
  ) {
    return securityRequestContext.exit(() =>
      this.prisma.$transaction(async (tx) => {
        await this.lockBrand(tx, row.brandId);
        await tx.$queryRaw`SELECT "id" FROM "StorePaymentAccountSync" WHERE "id"=${row.id}::uuid FOR UPDATE`;
        const current = await tx.storePaymentAccountSync.findUnique({
          where: { id: row.id },
        });
        const now = await this.now(tx);
        if (
          !current ||
          current.brandId !== row.brandId ||
          current.commandDigest !== row.commandDigest ||
          current.leaseToken !== row.leaseToken ||
          current.finishedAt ||
          !current.leaseExpiresAt ||
          current.leaseExpiresAt <= now
        )
          throw pending();
        await tx.storePaymentAccountSync.update({
          where: { id: row.id },
          data: { leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
        });
        return work(tx, current, now);
      }),
    );
  }
  private stage(
    row: StorePaymentAccountSync,
    stage: string,
    data: Prisma.StorePaymentAccountSyncUpdateInput = {},
  ) {
    return this.fenced(row, (tx) =>
      tx.storePaymentAccountSync.update({
        where: { id: row.id },
        data: { ...data, stage },
      }),
    );
  }
  private async reconcileSubaccount(
    row: StorePaymentAccountSync,
    command: PaymentAccountCommand,
  ) {
    // A create with a lost response is never blindly repeated. Metadata gives this attempt its own identity.
    const from = encodeURIComponent(
      new Date(row.createdAt.getTime() - 300_000).toISOString(),
    );
    let found: ProviderRecord | null = null;
    for (let page = 1; page <= 20; page++) {
      await this.fenced(row, async () => undefined);
      const entries: ProviderRecord[] = await this.provider(
        `/subaccount?perPage=100&page=${page}&from=${from}`,
        { method: 'GET' },
      );
      if (!Array.isArray(entries)) throw pending();
      const matches = entries.filter((entry) => {
        let metadata = entry.metadata;
        if (typeof metadata === 'string') {
          try {
            metadata = JSON.parse(metadata);
          } catch {
            return false;
          }
        }
        return (
          metadata?.wiezAccountSyncId === row.id &&
          metadata?.wiezBrandId === command.brandId
        );
      });
      if (matches.length > 1 || (found && matches.length)) throw pending();
      if (matches.length === 1) found = matches[0];
      if (entries.length < 100) {
        if (found) return found;
        break;
      }
    }
    throw pending();
  }
  private validateRecipient(
    value: ProviderRecord,
    command: PaymentAccountCommand,
  ) {
    const details = value?.details;
    if (
      !value?.recipient_code ||
      value.active !== true ||
      details?.bank_code !== command.bankCode ||
      String(details?.account_number ?? '') !== command.accountNumber ||
      value.currency !== 'NGN'
    )
      throw pending();
  }

  async synchronize(
    command: PaymentAccountCommand,
    encryptAccountNumber: (value: string) => string,
  ) {
    let row = await this.admit(command);
    // All provider input comes from authenticated, persisted ciphertext, not a mutable request closure.
    const saved = this.unseal<PaymentAccountCommand>(
      row,
      'command',
      row.commandEncrypted,
    );
    if (this.identity.digest(saved) !== row.commandDigest) throw pending();
    try {
      await this.fenced(row, async () => undefined);
      const resolved = saved.devBypass
        ? {
            account_number: saved.accountNumber,
            account_name: saved.primaryContactName || saved.businessName,
          }
        : await this.provider(
            `/bank/resolve?account_number=${encodeURIComponent(saved.accountNumber)}&bank_code=${encodeURIComponent(saved.bankCode)}`,
            { method: 'GET' },
          );
      if (
        resolved?.account_number !== saved.accountNumber ||
        !String(resolved?.account_name ?? '').trim()
      )
        throw pending();
      let subaccount = row.subaccountEncrypted
        ? this.unseal<ProviderRecord>(
            row,
            'subaccount',
            row.subaccountEncrypted,
          )
        : null;
      let recipient = row.recipientEncrypted
        ? this.unseal<ProviderRecord>(row, 'recipient', row.recipientEncrypted)
        : null;
      if (!saved.devBypass && !subaccount) {
        if (
          !saved.previous?.subaccountCode &&
          ['SUBACCOUNT_CREATING', 'SUBACCOUNT_CREATE_UNKNOWN'].includes(
            row.stage,
          )
        ) {
          subaccount = await this.reconcileSubaccount(row, saved);
        } else {
          row = await this.stage(
            row,
            saved.previous?.subaccountCode
              ? 'SUBACCOUNT_UPDATING'
              : 'SUBACCOUNT_CREATING',
          );
          const body = {
            business_name: saved.businessName,
            bank_code: saved.bankCode,
            account_number: saved.accountNumber,
            percentage_charge: 0,
            primary_contact_name: saved.primaryContactName,
            primary_contact_email: saved.primaryContactEmail ?? undefined,
            primary_contact_phone: saved.primaryContactPhone ?? undefined,
            settlement_schedule: 'manual',
            description: `WIEZ brand settlement account for ${saved.businessName}`,
            metadata: JSON.stringify({
              wiezBrandId: saved.brandId,
              wiezOwnerId: saved.actorId,
              wiezAccountSyncId: row.id,
            }),
          };
          subaccount = await this.provider(
            saved.previous?.subaccountCode
              ? `/subaccount/${encodeURIComponent(saved.previous.subaccountCode)}`
              : '/subaccount',
            {
              method: saved.previous?.subaccountCode ? 'PUT' : 'POST',
              bodyJson: body,
            },
          );
        }
        if (
          !subaccount?.subaccount_code ||
          subaccount.account_number !== saved.accountNumber ||
          subaccount.currency !== 'NGN' ||
          (resolved.bank_id != null &&
            String(subaccount.bank_id ?? subaccount.bank) !==
              String(resolved.bank_id)) ||
          (saved.previous?.subaccountCode &&
            subaccount.subaccount_code !== saved.previous.subaccountCode)
        )
          throw pending();
        row = await this.stage(row, 'SUBACCOUNT_READY', {
          subaccountEncrypted: this.seal(
            row.brandId,
            row.id,
            'subaccount',
            subaccount,
          ),
        });
      }
      if (!saved.devBypass && !recipient) {
        row = await this.stage(row, 'RECIPIENT_SYNCING');
        const reuse =
          saved.previous?.recipientCode &&
          saved.previous.bankFingerprint === row.bankFingerprint;
        if (reuse) {
          recipient = await this.provider(
            `/transferrecipient/${encodeURIComponent(saved.previous!.recipientCode!)}`,
            { method: 'GET' },
          );
          this.validateRecipient(recipient, saved);
          const updated = await this.provider(
            `/transferrecipient/${encodeURIComponent(recipient.recipient_code)}`,
            {
              method: 'PUT',
              bodyJson: {
                name: resolved.account_name,
                email: saved.primaryContactEmail ?? undefined,
              },
            },
          );
          recipient = { ...recipient, ...updated };
        } else {
          recipient = await this.provider('/transferrecipient', {
            method: 'POST',
            bodyJson: {
              type: 'nuban',
              name: resolved.account_name,
              account_number: saved.accountNumber,
              bank_code: saved.bankCode,
              currency: 'NGN',
              metadata: {
                wiezBrandId: saved.brandId,
                wiezAccountSyncId: row.id,
              },
            },
          });
        }
        this.validateRecipient(recipient!, saved);
        row = await this.fenced(row, async (tx) => {
          const other = await tx.storePayoutBankClaim.findFirst({
            where: {
              recipientCode: recipient!.recipient_code,
              fingerprint: { not: row.bankFingerprint },
            },
            select: { fingerprint: true },
          });
          const account = await tx.storePaymentAccount.findUnique({
            where: { transferRecipientCode: recipient!.recipient_code },
            select: { brandId: true },
          });
          if (other || (account && account.brandId !== row.brandId))
            throw new ConflictException({
              code: 'PAYOUT_RECIPIENT_OWNERSHIP_CONFLICT',
              message:
                'Payout recipient ownership needs review before this update can continue. Contact support.',
            });
          await tx.storePayoutBankClaim.update({
            where: { fingerprint: row.bankFingerprint },
            data: { recipientCode: recipient!.recipient_code },
          });
          return tx.storePaymentAccountSync.update({
            where: { id: row.id },
            data: {
              stage: 'RECIPIENT_READY',
              recipientEncrypted: this.seal(
                row.brandId,
                row.id,
                'recipient',
                recipient,
              ),
            },
          });
        });
      }
      const result = await this.fenced(row, async (tx, current, now) => {
        const account = await tx.storePaymentAccount.findUnique({
          where: { brandId: saved.brandId },
        });
        if (
          (account?.updatedAt.toISOString() ?? null) !==
          (saved.previous?.updatedAt ?? null)
        )
          throw pending();
        const data = {
          status: 'ACTIVE' as const,
          provider: 'PAYSTACK',
          countryCode: 'NG',
          currency: 'NGN',
          businessName: saved.businessName,
          primaryContactName: saved.primaryContactName,
          primaryContactEmail: saved.primaryContactEmail,
          primaryContactPhone: saved.primaryContactPhone,
          bankCode: saved.bankCode,
          bankName: saved.bankName,
          accountName: resolved.account_name,
          accountNumberEncrypted: encryptAccountNumber(saved.accountNumber),
          accountNumberLast4: saved.accountNumber.slice(-4),
          bankClaimFingerprint: current.bankFingerprint,
          isAccountResolved: true,
          accountResolvedAt: now,
          subaccountCode:
            subaccount?.subaccount_code ?? account?.subaccountCode ?? null,
          subaccountId:
            subaccount?.id != null
              ? String(subaccount.id)
              : (account?.subaccountId ?? null),
          subaccountActive: Boolean(
            subaccount?.active ?? account?.subaccountActive,
          ),
          subaccountVerified: Boolean(
            subaccount?.is_verified ?? account?.subaccountVerified,
          ),
          subaccountLastSyncAt: subaccount
            ? now
            : (account?.subaccountLastSyncAt ?? null),
          transferRecipientCode:
            recipient?.recipient_code ?? account?.transferRecipientCode ?? null,
          transferRecipientId:
            recipient?.id != null
              ? String(recipient.id)
              : (account?.transferRecipientId ?? null),
          transferRecipientActive: Boolean(
            recipient?.active ?? account?.transferRecipientActive,
          ),
          transferRecipientLastSyncAt: recipient
            ? now
            : (account?.transferRecipientLastSyncAt ?? null),
          lastSyncError: null,
          metadata: {
            ...(account?.metadata &&
            typeof account.metadata === 'object' &&
            !Array.isArray(account.metadata)
              ? account.metadata
              : {}),
            paystackBankId: resolved.bank_id ?? null,
            lastProviderSyncAt: now.toISOString(),
            lastSuccessfulSyncAt: now.toISOString(),
            accountSyncId: row.id,
            syncMode: !saved.previous
              ? 'INITIAL_SETUP'
              : saved.previous.bankFingerprint === current.bankFingerprint
                ? 'RESYNC'
                : 'BANK_DETAILS_UPDATE',
          },
        };
        const updated = await tx.storePaymentAccount.upsert({
          where: { brandId: saved.brandId },
          create: { ...data, brandId: saved.brandId },
          update: data,
        });
        if (
          saved.previous?.recipientCode &&
          recipient &&
          saved.previous.recipientCode !== recipient.recipient_code
        ) {
          await tx.storePayoutRecipientRetirement.upsert({
            where: { recipientCode: saved.previous.recipientCode },
            create: {
              recipientCode: saved.previous.recipientCode,
              brandId: saved.brandId,
              bankFingerprint: saved.previous.bankFingerprint,
              replacementCode: recipient.recipient_code,
            },
            update: {},
          });
        } else if (
          saved.previous?.bankFingerprint &&
          saved.previous.bankFingerprint !== current.bankFingerprint &&
          !saved.previous.recipientCode
        ) {
          await tx.storePayoutBankClaim.deleteMany({
            where: {
              fingerprint: saved.previous.bankFingerprint,
              brandId: saved.brandId,
            },
          });
        }
        await tx.storePaymentAccountSync.update({
          where: { id: row.id },
          data: {
            stage: 'APPLIED',
            finishedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
        return updated;
      });
      return result;
    } catch (error) {
      // Never delete a "new" recipient: Paystack may have returned an existing one.
      // Retain the bank reservation and durable command for reconciliation, even after logout.
      await this.fenced(row, async (tx, current, now) => {
        const beforeMutation = current.stage === 'ADMITTED';
        await tx.storePaymentAccountSync.update({
          where: { id: row.id },
          data: {
            stage: beforeMutation
              ? 'FAILED'
              : current.stage === 'SUBACCOUNT_CREATING'
                ? 'SUBACCOUNT_CREATE_UNKNOWN'
                : current.stage,
            finishedAt: beforeMutation ? now : null,
            failureCode: beforeMutation
              ? 'ACCOUNT_RESOLUTION_FAILED'
              : 'PROVIDER_RECONCILIATION_REQUIRED',
            leaseExpiresAt: new Date(0),
          },
        });
        if (
          beforeMutation &&
          saved.previous?.bankFingerprint !== current.bankFingerprint
        ) {
          await tx.storePayoutBankClaim.deleteMany({
            where: {
              fingerprint: current.bankFingerprint,
              brandId: saved.brandId,
              recipientCode: null,
            },
          });
        }
      }).catch(() => undefined);
      if (error instanceof ConflictException) throw error;
      throw pending();
    }
  }

  async retireUnusedRecipients() {
    if (getLiveSecurityContext())
      throw new ForbiddenException(
        'Recipient retirement is a background operation',
      );
    // Filter before LIMIT: pending payouts must not starve unrelated eligible retirements.
    const candidates = await this.prisma.$queryRaw<
      Array<{
        recipientCode: string;
        brandId: string;
        bankFingerprint: string | null;
      }>
    >`
      SELECT r."recipientCode",r."brandId",r."bankFingerprint" FROM "StorePayoutRecipientRetirement" r
      WHERE r."retiredAt" IS NULL AND (r."leaseExpiresAt" IS NULL OR r."leaseExpiresAt" <= clock_timestamp())
        AND NOT EXISTS (SELECT 1 FROM "StorePaymentAccount" a WHERE a."transferRecipientCode"=r."recipientCode")
        AND NOT EXISTS (SELECT 1 FROM "StorePaymentAccountSync" s WHERE s."brandId"=r."brandId" AND s."finishedAt" IS NULL)
        AND NOT EXISTS (SELECT 1 FROM "Payout" p WHERE p."providerRecipientCode"=r."recipientCode" AND
          (p."status" NOT IN ('PAID','REJECTED') OR p."transferLeaseToken" IS NOT NULL OR
            (p."status"='REJECTED' AND p."providerTransferInitiatedAt" IS NOT NULL)))
      ORDER BY r."createdAt",r."recipientCode" LIMIT 10`;
    for (const candidate of candidates) {
      const token = randomUUID();
      const admitted = await this.prisma.$transaction(async (tx) => {
        await this.lockBrand(tx, candidate.brandId);
        await tx.$queryRaw`SELECT "recipientCode" FROM "StorePayoutRecipientRetirement" WHERE "recipientCode"=${candidate.recipientCode} FOR UPDATE`;
        const current =
          await tx.storePayoutRecipientRetirement.findUniqueOrThrow({
            where: { recipientCode: candidate.recipientCode },
          });
        const now = await this.now(tx);
        if (
          current.retiredAt ||
          (current.leaseExpiresAt && current.leaseExpiresAt > now)
        )
          return false;
        const [account, sync, payout] = await Promise.all([
          tx.storePaymentAccount.findUnique({
            where: { transferRecipientCode: current.recipientCode },
            select: { id: true },
          }),
          tx.storePaymentAccountSync.findFirst({
            where: { brandId: current.brandId, finishedAt: null },
            select: { id: true },
          }),
          tx.payout.findFirst({
            where: {
              providerRecipientCode: current.recipientCode,
              OR: [
                { status: { notIn: ['PAID', 'REJECTED'] } },
                { transferLeaseToken: { not: null } },
                {
                  status: 'REJECTED',
                  providerTransferInitiatedAt: { not: null },
                },
              ],
            },
            select: { id: true },
          }),
        ]);
        if (account || sync || payout) return false;
        await tx.storePayoutRecipientRetirement.update({
          where: { recipientCode: current.recipientCode },
          data: {
            leaseToken: token,
            leaseExpiresAt: new Date(now.getTime() + LEASE_MS),
          },
        });
        return true;
      });
      if (!admitted) continue;
      try {
        const path = `/transferrecipient/${encodeURIComponent(candidate.recipientCode)}`;
        let remote: ProviderRecord | null;
        try {
          remote = await this.provider(path, { method: 'GET' });
        } catch (error) {
          if (
            (error as { [STORE_PAYMENT_PROVIDER_STATUS]?: number })?.[
              STORE_PAYMENT_PROVIDER_STATUS
            ] !== 404
          )
            throw error;
          remote = null;
        }
        if (remote && remote.recipient_code !== candidate.recipientCode)
          throw pending();
        if (remote?.active === true && remote.is_deleted !== true) {
          // A lookup is an await boundary: recheck the exact admitted retirement before deletion.
          const stillOwned = await this.prisma.$transaction(async (tx) => {
            await this.lockBrand(tx, candidate.brandId);
            const current = await tx.storePayoutRecipientRetirement.findFirst({
              where: {
                recipientCode: candidate.recipientCode,
                leaseToken: token,
                retiredAt: null,
                leaseExpiresAt: { gt: await this.now(tx) },
              },
              select: { recipientCode: true },
            });
            if (!current) return false;
            return !(await tx.storePaymentAccount.findUnique({
              where: { transferRecipientCode: candidate.recipientCode },
              select: { id: true },
            }));
          });
          if (!stillOwned) continue;
          await this.provider(path, { method: 'DELETE' });
        } else if (
          remote &&
          remote.active !== false &&
          remote.is_deleted !== true
        )
          throw pending();
        await this.prisma.$transaction(async (tx) => {
          await this.lockBrand(tx, candidate.brandId);
          const done = await tx.storePayoutRecipientRetirement.updateMany({
            where: {
              recipientCode: candidate.recipientCode,
              leaseToken: token,
              retiredAt: null,
              leaseExpiresAt: { gt: await this.now(tx) },
            },
            data: {
              retiredAt: new Date(),
              leaseToken: null,
              leaseExpiresAt: null,
            },
          });
          if (done.count && candidate.bankFingerprint)
            await tx.storePayoutBankClaim.deleteMany({
              where: {
                fingerprint: candidate.bankFingerprint,
                brandId: candidate.brandId,
                recipientCode: candidate.recipientCode,
              },
            });
        });
      } catch {
        // Keep the reservation and lease for reconciliation. Never publish bank/provider error text.
      }
    }
  }
}
