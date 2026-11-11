import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type BrandSubscriptionCheckoutCommand } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { PrismaService } from 'src/prisma/prisma.service';
import { getLiveSecurityContext } from 'src/auth/access/security-request-context';
import {
  encryptSubscriptionAuthorization,
  decryptSubscriptionAuthorization,
} from './subscription-authorization.crypto';
import { subscriptionDatabaseNow } from './subscription-quotes';
import {
  loadSubscriptionVerificationInvoice,
  type SubscriptionVerificationInvoice,
} from './subscription-invoice-query';
import type { SubscriptionPaystackService } from './subscription-paystack.service';
import { savedPaymentMethodVersion } from 'src/payment/saved-payment-method-version';

const openStates = ['READY', 'DISPATCHED', 'WAITING', 'REVIEW'];
const paidStates = ['PAID', 'PAID_REVIEW', 'PAYMENT_REVIEW'];
const terminalInvoices = [...paidStates, 'CANCELLED', 'EXPIRED'];
type Instruction = {
  version: 1;
  invoiceId: string;
  brandId: string;
  actorId: string;
  amountKobo: number;
  currency: 'NGN';
  reference: string;
  email: string;
  callbackUrl: string | null;
  savedCardId: string | null;
  authorizationCode: string | null;
  savedCardVersion: string | null;
  priorReferences: string[];
  submittedReferences: string[];
};

/** Immutable, encrypted payment instruction; only the admitted transaction may create it. */
export class SubscriptionCheckoutCommands {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: SubscriptionPaystackService,
    private readonly verify: (
      invoice: SubscriptionVerificationInvoice,
      reference: string,
    ) => Promise<string>,
    private readonly confirmFree: (
      invoice: SubscriptionVerificationInvoice,
      email: string,
    ) => Promise<string>,
  ) {}

  private aad(id: string, invoiceId: string, brandId: string) {
    return `checkout-command:${brandId}:${invoiceId}:${id}`;
  }

  private decode(
    row: BrandSubscriptionCheckoutCommand,
    brandId: string,
  ): Instruction {
    const text = decryptSubscriptionAuthorization(
      row.commandCiphertext,
      this.aad(row.id, row.invoiceId, brandId),
    );
    let value: Instruction;
    try {
      value = JSON.parse(text ?? 'null');
    } catch {
      throw this.unavailable();
    }
    if (
      !value ||
      value.version !== 1 ||
      value.invoiceId !== row.invoiceId ||
      value.brandId !== brandId ||
      value.reference !== row.reference ||
      value.currency !== 'NGN' ||
      !Number.isSafeInteger(value.amountKobo) ||
      value.amountKobo < 0 ||
      typeof value.actorId !== 'string' ||
      typeof value.email !== 'string' ||
      !value.email ||
      (value.callbackUrl !== null && typeof value.callbackUrl !== 'string') ||
      !Array.isArray(value.priorReferences) ||
      !Array.isArray(value.submittedReferences) ||
      value.priorReferences.length > 25 ||
      value.submittedReferences.length > 25 ||
      !value.priorReferences.every((ref) => typeof ref === 'string') ||
      !value.submittedReferences.every((ref) => typeof ref === 'string') ||
      (value.savedCardId !== null &&
        (typeof value.savedCardId !== 'string' ||
          !/^[a-f0-9]{64}$/.test(value.savedCardVersion ?? '') ||
          typeof value.authorizationCode !== 'string' ||
          !value.authorizationCode)) ||
      (value.savedCardId === null && value.authorizationCode !== null)
    )
      throw this.unavailable();
    return value;
  }

  private unavailable() {
    return new ServiceUnavailableException(
      'The saved payment instruction could not be verified. No new charge was initiated.',
    );
  }

  async admit(
    tx: Prisma.TransactionClient,
    invoiceId: string,
    input: {
      actorId: string;
      brandId: string;
      email: string;
      callbackUrl: string | null;
      savedCardId: string | null;
      authorizationCode: string | null;
      savedCardVersion: string | null;
    },
  ) {
    const context = getLiveSecurityContext();
    const op = context?.operation;
    if (
      !context ||
      context.transaction !== tx ||
      op?.actor.id !== input.actorId ||
      op.policy.brandId !== input.brandId ||
      op.policy.action !== 'brand.billing.change' ||
      op.policy.sensitivity !== 'CRITICAL_CHANGE' ||
      op.policy.scope !== 'BRAND_OWNER' ||
      op.method !== 'POST' ||
      op.route !== '/brands/:brandId/subscription/checkout'
    )
      throw this.unavailable();
    const invoice = await loadSubscriptionVerificationInvoice(tx, {
      id: invoiceId,
    });
    if (
      !invoice ||
      invoice.subscription.brandId !== input.brandId ||
      terminalInvoices.includes(invoice.status)
    )
      throw new ConflictException('Review the current invoice before paying.');
    const existing = await tx.brandSubscriptionCheckoutCommand.findFirst({
      where: { invoiceId, state: { in: openStates } },
    });
    if (existing) {
      const saved = this.decode(existing, input.brandId);
      if (
        existing.state === 'REVIEW' ||
        saved.actorId !== input.actorId ||
        saved.savedCardId !== input.savedCardId ||
        saved.email !== input.email
      )
        throw new ConflictException(
          'An earlier payment needs reconciliation. Review its status before starting another payment.',
        );
      return existing.id;
    }
    if (invoice.lockedAt)
      throw new ConflictException(
        'An earlier billing worker must finish or reconcile this invoice before another payment can start.',
      );
    const otherCheckout = await tx.brandSubscriptionCheckoutCommand.findFirst({
      where: {
        invoice: { subscription: { brandId: input.brandId } },
        state: { in: openStates },
      },
      select: { id: true },
    });
    if (otherCheckout)
      throw new ConflictException(
        'This brand already has a payment awaiting completion or reconciliation. Review that payment before changing plans again.',
      );
    const history = invoice.hostedAttemptReferences ?? [];
    if (history.length >= 20)
      throw new ConflictException(
        'Repeated payment attempts need billing support. No new charge was initiated.',
      );
    const references = [
      ...new Set([
        invoice.reference,
        ...Array.from(
          { length: Math.min(4, invoice.attemptCount) },
          (_, i) => `${invoice.reference}-a${i + 1}`,
        ),
        ...history,
        ...(invoice.hostedReference ? [invoice.hostedReference] : []),
      ]),
    ];
    const reference =
      history.length || invoice.attemptCount || invoice.hostedReference
        ? `${invoice.reference}-h${randomUUID()}`
        : invoice.reference;
    const now = await subscriptionDatabaseNow(tx),
      id = randomUUID();
    const command: Instruction = {
      version: 1,
      invoiceId,
      ...input,
      currency: 'NGN',
      reference,
      amountKobo: Math.round(Number(invoice.amount) * 100),
      priorReferences: references,
      submittedReferences: [
        ...new Set([
          ...history,
          ...(invoice.hostedReference ? [invoice.hostedReference] : []),
          ...references.filter((ref) => /-a[1-4]$/.test(ref)),
        ]),
      ],
    };
    const ciphertext = encryptSubscriptionAuthorization(
      JSON.stringify(command),
      this.aad(id, invoiceId, input.brandId),
    );
    if (!ciphertext) throw this.unavailable();
    await tx.brandSubscriptionCheckoutCommand.create({
      data: {
        id,
        invoiceId,
        reference,
        commandCiphertext: ciphertext,
        nextAttemptAt: now,
      },
    });
    const identities =
      invoice.paymentIdentityJson &&
      typeof invoice.paymentIdentityJson === 'object' &&
      !Array.isArray(invoice.paymentIdentityJson)
        ? invoice.paymentIdentityJson
        : {};
    await tx.brandSubscriptionInvoice.update({
      where: { id: invoiceId },
      data: {
        hostedReference: reference,
        hostedAttemptReferences: history.includes(reference)
          ? history
          : [...history, reference],
        paymentIdentityJson: {
          ...identities,
          [reference]: { email: input.email },
        },
        status: 'HOSTED_INITIALIZING',
        lockedAt: null,
        nextAttemptAt: now,
        authorizationUrl: null,
        providerAccessCode: null,
      },
    });
    return id;
  }

  private async finish(
    id: string,
    leaseToken: string,
    state: string,
    error: string | null,
    invoiceData: Prisma.BrandSubscriptionInvoiceUpdateManyMutationInput = {},
  ) {
    await this.prisma.$transaction(async (tx) => {
      const now = await subscriptionDatabaseNow(tx);
      const current =
        await tx.brandSubscriptionCheckoutCommand.findUniqueOrThrow({
          where: { id },
        });
      const changed = await tx.brandSubscriptionCheckoutCommand.updateMany({
        where: {
          id,
          leaseToken,
          leaseUntil: { gt: now },
          state: { in: ['READY', 'DISPATCHED', 'WAITING'] },
        },
        data: {
          state,
          lastError: error,
          leaseToken: null,
          leaseUntil: null,
          nextAttemptAt: ['READY', 'WAITING'].includes(state)
            ? new Date(+now + 60_000)
            : null,
        },
      });
      if (!changed.count) return;
      await tx.brandSubscriptionInvoice.updateMany({
        where: {
          id: current.invoiceId,
          hostedReference: current.reference,
          status: { notIn: terminalInvoices },
        },
        data: { ...invoiceData, lockedAt: null, lastError: error },
      });
    });
  }

  private async preflight(id: string, leaseToken: string, ciphertext: string) {
    const [row] = await this.prisma.$queryRaw<
      Array<{ allowed: boolean }>
    >(Prisma.sql`
      SELECT TRUE AS allowed FROM "BrandSubscriptionCheckoutCommand" c
      JOIN "BrandSubscriptionInvoice" i ON i.id = c."invoiceId"
      WHERE c.id = ${id}::uuid AND c."leaseToken" = ${leaseToken}::uuid
        AND c."leaseUntil" > clock_timestamp() AND c."commandCiphertext" = ${ciphertext}
        AND c.state IN ('READY','DISPATCHED','WAITING') AND i."hostedReference" = c.reference
        AND i.status NOT IN ('PAID','PAID_REVIEW','PAYMENT_REVIEW','CANCELLED','EXPIRED')`);
    return Boolean(row?.allowed);
  }

  private async markDispatched(
    id: string,
    leaseToken: string,
    cmd: Instruction,
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (cmd.savedCardId) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'wiez-payment-methods-' + cmd.actorId}))`;
        const card = await tx.savedPaymentMethod.findFirst({
          where: {
            id: cmd.savedCardId,
            buyerId: cmd.actorId,
            status: 'ACTIVE',
          },
        });
        if (!card || savedPaymentMethodVersion(card) !== cmd.savedCardVersion)
          return 'CARD_CHANGED' as const;
      }
      const marked = await tx.$executeRaw(Prisma.sql`
        UPDATE "BrandSubscriptionCheckoutCommand" SET state = 'DISPATCHED', "dispatchedAt" = clock_timestamp(), "updatedAt" = clock_timestamp()
        WHERE id = ${id}::uuid AND "leaseToken" = ${leaseToken}::uuid AND "leaseUntil" > clock_timestamp()
          AND state = 'READY' AND "dispatchedAt" IS NULL`);
      return marked ? ('MARKED' as const) : ('UNCHANGED' as const);
    });
  }

  async execute(id: string) {
    const leaseToken = randomUUID();
    const claimed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "BrandSubscriptionCheckoutCommand" SET "leaseToken" = ${leaseToken}::uuid,
        "leaseUntil" = clock_timestamp() + INTERVAL '2 minutes', "updatedAt" = clock_timestamp()
      WHERE id = ${id}::uuid AND state IN ('READY','DISPATCHED','WAITING')
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= clock_timestamp())`);
    if (!claimed) return this.result(id);
    const row =
      await this.prisma.brandSubscriptionCheckoutCommand.findUniqueOrThrow({
        where: { id },
      });
    const invoice = await loadSubscriptionVerificationInvoice(this.prisma, {
      id: row.invoiceId,
    });
    if (!invoice) throw this.unavailable();
    let instructionValid = false;
    try {
      const cmd = this.decode(row, invoice.subscription.brandId);
      if (
        cmd.amountKobo !== Math.round(Number(invoice.amount) * 100) ||
        cmd.currency !== invoice.currency
      )
        throw this.unavailable();
      instructionValid = true;
      if (terminalInvoices.includes(invoice.status)) {
        await this.finish(
          id,
          leaseToken,
          invoice.status === 'PAYMENT_REVIEW'
            ? 'REVIEW'
            : paidStates.includes(invoice.status)
              ? 'SUCCEEDED'
              : 'FAILED',
          null,
        );
        return this.result(id);
      }
      if (cmd.amountKobo === 0) {
        if (!(await this.preflight(id, leaseToken, row.commandCiphertext)))
          return this.result(id);
        const status = await this.confirmFree(invoice, cmd.email);
        await this.finish(
          id,
          leaseToken,
          status === 'PAID' ? 'SUCCEEDED' : 'REVIEW',
          null,
        );
        return this.result(id);
      }
      // Verify each durably named reference. A missing submitted reference is uncertainty, not permission to debit.
      for (const reference of [
        ...new Set([...cmd.priorReferences, cmd.reference]),
      ]) {
        if (!(await this.preflight(id, leaseToken, row.commandCiphertext)))
          return this.result(id);
        const status = await this.verify(invoice, reference);
        if (status === 'REVIEW') {
          await this.finish(
            id,
            leaseToken,
            'REVIEW',
            'The payment identity or amount needs billing review.',
            { status: 'PAYMENT_REVIEW', nextAttemptAt: null },
          );
          return this.result(id);
        }
        if (status === 'PAID' || status === 'PAID_REVIEW') {
          await this.finish(id, leaseToken, 'SUCCEEDED', null);
          return this.result(id);
        }
        if (status === 'PENDING') {
          await this.finish(id, leaseToken, 'WAITING', null, {
            status: 'ACTION_REQUIRED',
          });
          return this.result(id);
        }
        if (
          status === 'NOT_FOUND' &&
          (cmd.submittedReferences.includes(reference) ||
            (reference === cmd.reference && row.dispatchedAt))
        ) {
          await this.finish(
            id,
            leaseToken,
            'REVIEW',
            'An earlier payment is uncertain. Reconcile its original reference before another debit.',
            { status: 'ACTION_REQUIRED', nextAttemptAt: null },
          );
          return this.result(id);
        }
        if (reference === cmd.reference && row.dispatchedAt) {
          await this.finish(
            id,
            leaseToken,
            'FAILED',
            'The provider confirmed that payment did not complete.',
            { status: 'FAILED', nextAttemptAt: null },
          );
          return this.result(id);
        }
      }
      if (invoice.periodEnd <= new Date()) {
        await this.finish(
          id,
          leaseToken,
          'FAILED',
          'The billing period ended before payment began. Review a fresh quote.',
          { status: 'EXPIRED', nextAttemptAt: null },
        );
        return this.result(id);
      }
      // Card removal and committed dispatch are ordered by the same account lock.
      // Once marked, the provider instruction is in flight and can only be reconciled.
      const marked = await this.markDispatched(id, leaseToken, cmd);
      if (marked === 'CARD_CHANGED') {
        await this.finish(
          id,
          leaseToken,
          'FAILED',
          'The saved card changed before dispatch. Review billing and approve a fresh payment.',
          { status: 'ACTION_REQUIRED', nextAttemptAt: null },
        );
        return this.result(id);
      }
      // This committed marker is the point of no replay, including a crash immediately before HTTP.
      if (
        marked !== 'MARKED' ||
        !(await this.preflight(id, leaseToken, row.commandCiphertext))
      )
        return this.result(id);
      const payment = cmd.savedCardId
        ? await this.provider.charge(
            cmd.reference,
            cmd.amountKobo,
            cmd.authorizationCode!,
            cmd.email,
          )
        : await this.provider.initialize(
            cmd.reference,
            cmd.amountKobo,
            cmd.email,
            cmd.callbackUrl ?? undefined,
          );
      if (
        !payment ||
        payment.reference !== cmd.reference ||
        (!cmd.savedCardId &&
          (!payment.authorization_url || !payment.access_code))
      )
        throw this.unavailable();
      if (cmd.savedCardId) {
        if (!(await this.preflight(id, leaseToken, row.commandCiphertext)))
          return this.result(id);
        const status = await this.verify(invoice, cmd.reference);
        if (status === 'PAID' || status === 'PAID_REVIEW') {
          await this.finish(id, leaseToken, 'SUCCEEDED', null);
          return this.result(id);
        }
        if (status === 'REVIEW') {
          await this.finish(
            id,
            leaseToken,
            'REVIEW',
            'The payment identity or amount needs billing review.',
            { status: 'PAYMENT_REVIEW', nextAttemptAt: null },
          );
          return this.result(id);
        }
        if (status === 'FAILED') {
          await this.finish(
            id,
            leaseToken,
            'FAILED',
            'The provider confirmed that payment did not complete.',
            { status: 'FAILED', nextAttemptAt: null },
          );
          return this.result(id);
        }
      }
      await this.finish(id, leaseToken, 'WAITING', null, {
        status: cmd.savedCardId ? 'PROCESSING' : 'PENDING',
        authorizationUrl: payment.authorization_url ?? null,
        providerAccessCode: payment.access_code ?? null,
        nextAttemptAt: new Date(Date.now() + 60_000),
      });
      return this.result(id);
    } catch {
      // Provider timeouts and local failures are recorded without depending on the initiating session.
      const fresh =
        await this.prisma.brandSubscriptionCheckoutCommand.findUniqueOrThrow({
          where: { id },
        });
      await this.finish(
        id,
        leaseToken,
        !instructionValid ? 'REVIEW' : fresh.dispatchedAt ? 'WAITING' : 'READY',
        'Payment response is uncertain. Checking the existing reference before any new debit.',
        {
          status: 'ACTION_REQUIRED',
          nextAttemptAt: new Date(Date.now() + 60_000),
        },
      );
      return this.result(id);
    }
  }

  private async result(id: string) {
    const command =
      await this.prisma.brandSubscriptionCheckoutCommand.findUniqueOrThrow({
        where: { id },
        select: {
          reference: true,
          state: true,
          invoice: {
            select: {
              status: true,
              hostedReference: true,
              amount: true,
              periodStart: true,
              authorizationUrl: true,
              providerAccessCode: true,
            },
          },
        },
      });
    return {
      reference: command.reference,
      commandState: command.state,
      status: command.invoice.status,
      amountNgn: Number(command.invoice.amount),
      effectiveAt: command.invoice.periodStart,
      authorizationUrl:
        command.invoice.hostedReference === command.reference
          ? command.invoice.authorizationUrl
          : null,
      providerAccessCode:
        command.invoice.hostedReference === command.reference
          ? command.invoice.providerAccessCode
          : null,
    };
  }

  async recoverDue() {
    const rows = await this.prisma.brandSubscriptionCheckoutCommand.findMany({
      where: {
        state: { in: ['READY', 'DISPATCHED', 'WAITING'] },
        nextAttemptAt: { lte: new Date() },
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: new Date() } }],
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: 10,
      select: { id: true },
    });
    for (const row of rows) await this.execute(row.id);
  }
}
