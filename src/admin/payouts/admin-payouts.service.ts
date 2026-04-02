import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  AdminAuditAction,
  CustomOrderLedgerAllocationStatus,
  PayoutStatus,
  Role,
} from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { LedgerService } from 'src/finance/ledger.service';
import { FinancialDocumentsService } from 'src/finance/financial-documents.service';
import {
  WebhookEventsQueueService,
  type PayoutWebhookProcessJob,
} from 'src/queue/webhook-events.queue.service';
import { buildPayoutSourceBreakdown } from 'src/payout/payout-detail.presenter';

type WebhookContext = {
  headers: Record<string, any>;
  rawBody?: string;
  remoteAddress?: string | null;
};

const PAYSTACK_WEBHOOK_IPS = [
  '52.31.139.75',
  '52.49.173.169',
  '52.214.14.220',
] as const;

const VALID_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  [PayoutStatus.PENDING_APPROVAL]: [
    PayoutStatus.APPROVED,
    PayoutStatus.REJECTED,
    PayoutStatus.ON_HOLD,
  ],
  [PayoutStatus.APPROVED]: [
    PayoutStatus.PROCESSING,
    PayoutStatus.ON_HOLD,
    PayoutStatus.REJECTED,
  ],
  [PayoutStatus.PROCESSING]: [
    PayoutStatus.PAID,
    PayoutStatus.FAILED,
    PayoutStatus.RECONCILIATION_REVIEW,
  ],
  [PayoutStatus.FAILED]: [
    PayoutStatus.APPROVED,
    PayoutStatus.ON_HOLD,
    PayoutStatus.REJECTED,
  ],
  [PayoutStatus.REJECTED]: [],
  [PayoutStatus.ON_HOLD]: [PayoutStatus.APPROVED, PayoutStatus.REJECTED],
  [PayoutStatus.RECONCILIATION_REVIEW]: [
    PayoutStatus.APPROVED,
    PayoutStatus.PAID,
    PayoutStatus.FAILED,
    PayoutStatus.ON_HOLD,
  ],
  [PayoutStatus.PAID]: [],
};

@Injectable()
export class AdminPayoutsService {
  private readonly logger = new Logger(AdminPayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly financialDocumentsService: FinancialDocumentsService,
    private readonly webhookEventsQueue: WebhookEventsQueueService,
  ) {}

  async list(params: {
    status?: PayoutStatus;
    brandId?: string;
    cursor?: string;
    take?: number;
  }) {
    const take = Math.min(params.take ?? 20, 100);
    const where: Record<string, unknown> = {};
    if (params.status) where.status = params.status;
    if (params.brandId) where.brandId = params.brandId;

    const rows = await this.prisma.payout.findMany({
      where,
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: this.payoutInclude(),
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]?.id : undefined,
    };
  }

  async getById(payoutId: string) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      include: {
        ...this.payoutInclude(),
        ledgerSourceAllocations: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            amount: true,
            currency: true,
            createdAt: true,
            releaseStage: true,
            ledgerEntry: {
              select: {
                id: true,
                amount: true,
                createdAt: true,
                transaction: {
                  select: {
                    referenceId: true,
                    referenceType: true,
                    description: true,
                    totalAmount: true,
                    currency: true,
                    createdAt: true,
                  },
                },
              },
            },
            escrowHold: {
              select: {
                id: true,
                order: {
                  select: {
                    id: true,
                    customerName: true,
                    orderItems: {
                      take: 1,
                      orderBy: { createdAt: 'asc' },
                      select: {
                        nameAtPurchase: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
        ledgerAllocations: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            allocationType: true,
            amount: true,
            commissionAmount: true,
            netBrandAmount: true,
            currency: true,
            eligibleAt: true,
            createdAt: true,
            customOrderId: true,
            customOrder: {
              select: {
                id: true,
                sourceTitleSnapshot: true,
                buyer: {
                  select: {
                    firstName: true,
                    lastName: true,
                    username: true,
                  },
                },
              },
            },
          },
        },
        events: {
          orderBy: { createdAt: 'desc' },
          take: 30,
        },
      },
    });

    if (!payout) {
      throw new NotFoundException('Payout not found');
    }

    const paymentAccount = await (this.prisma as any).storePaymentAccount.findUnique({
      where: { brandId: payout.brandId },
    });

    return {
      ...payout,
      payoutAccount: this.summarizeStorePaymentAccount(paymentAccount),
      sourceBreakdown: buildPayoutSourceBreakdown(payout),
    };
  }

  async claim(
    payoutId: string,
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      select: {
        id: true,
        status: true,
        assignedAdminId: true,
      },
    });
    if (!payout) throw new NotFoundException('Payout not found');

    if (
      payout.assignedAdminId &&
      payout.assignedAdminId !== actorId &&
      actorRole !== Role.SuperAdmin
    ) {
      throw new ConflictException('Payout is already claimed by another admin');
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.payout.update({
        where: { id: payoutId },
        data: {
          assignedAdminId: actorId,
          assignedAt: payout.assignedAdminId ? undefined : now,
          claimedAt: now,
          releasedAt: null,
        },
        include: this.payoutInclude(),
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action:
            payout.assignedAdminId && payout.assignedAdminId !== actorId
              ? AdminAuditAction.ADMIN_PAYOUT_ASSIGN
              : AdminAuditAction.ADMIN_PAYOUT_CLAIM,
          targetType: 'Payout',
          targetId: payoutId,
          previousState: { assignedAdminId: payout.assignedAdminId },
          newState: { assignedAdminId: actorId, claimedAt: now.toISOString() },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async release(
    payoutId: string,
    actorId: string,
    actorRole: Role,
    req: Request,
    reason?: string,
  ) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      select: {
        id: true,
        assignedAdminId: true,
      },
    });
    if (!payout) throw new NotFoundException('Payout not found');

    this.assertOwnership(payout.assignedAdminId, actorId, actorRole);

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.payout.update({
        where: { id: payoutId },
        data: {
          assignedAdminId: null,
          claimedAt: null,
          releasedAt: now,
        },
        include: this.payoutInclude(),
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_PAYOUT_RELEASE,
          targetType: 'Payout',
          targetId: payoutId,
          previousState: { assignedAdminId: payout.assignedAdminId },
          newState: { assignedAdminId: null, releasedAt: now.toISOString(), reason: reason ?? null },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async updateStatus(
    payoutId: string,
    params: { status: PayoutStatus; reason?: string },
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
    });
    if (!payout) throw new NotFoundException('Payout not found');

    this.assertOwnership(payout.assignedAdminId, actorId, actorRole);

    const allowed = VALID_TRANSITIONS[payout.status];
    if (!allowed || !allowed.includes(params.status)) {
      throw new ConflictException(
        `Cannot transition payout from ${payout.status} to ${params.status}`,
      );
    }

    const now = new Date();
    const data: Record<string, unknown> = {
      status: params.status,
      statusReason: params.reason?.trim() || null,
    };

    if (params.status === PayoutStatus.APPROVED) {
      data.approvedById = actorId;
      data.approvedAt = now;
    }
    if (params.status === PayoutStatus.PROCESSING) {
      data.processedAt = payout.processedAt ?? now;
    }
    if (params.status === PayoutStatus.PAID) {
      data.paidAt = payout.paidAt ?? now;
      data.providerTransferFinalizedAt =
        payout.providerTransferFinalizedAt ?? now;
      data.failureReason = null;
      data.statusReason = null;
    }
    if (params.status === PayoutStatus.FAILED) {
      data.failureReason =
        params.reason?.trim() || 'Payout processing failed';
    }
    if (params.status === PayoutStatus.RECONCILIATION_REVIEW) {
      data.providerTransferReversedAt =
        payout.providerTransferReversedAt ?? now;
    }
    if (params.status !== PayoutStatus.FAILED) {
      data.failureReason = params.status === PayoutStatus.RECONCILIATION_REVIEW
        ? payout.failureReason ?? null
        : null;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.payout.update({
        where: { id: payoutId },
        data,
        include: this.payoutInclude(),
      });

      await this.applyPayoutStatusSideEffects(
        tx,
        payout,
        result,
        now,
        params.status,
      );

      await this.createPayoutEvent(tx, {
        payoutId: result.id,
        type: `STATUS_${params.status}`,
        source: 'manual-admin',
        processedAt: now,
        payload: {
          reason: params.reason?.trim() || null,
          actorId,
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_PAYOUT_STATUS_UPDATE,
          targetType: 'Payout',
          targetId: payoutId,
          previousState: {
            status: payout.status,
            statusReason: payout.statusReason,
          },
          newState: {
            status: params.status,
            statusReason: params.reason?.trim() || null,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async initiateTransfer(
    payoutId: string,
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    if (!this.isPayoutTransferExecutionEnabled()) {
      throw new BadRequestException(
        'Paystack payout transfer execution is currently disabled',
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await this.lockPayoutForUpdate(tx, payoutId);

      const current = await tx.payout.findUnique({
        where: { id: payoutId },
        include: this.payoutInclude(),
      });
      if (!current) {
        throw new NotFoundException('Payout not found');
      }

      this.assertOwnership(current.assignedAdminId, actorId, actorRole);

      const transferableStatuses = new Set<PayoutStatus>([
        PayoutStatus.APPROVED,
        PayoutStatus.FAILED,
        PayoutStatus.RECONCILIATION_REVIEW,
      ]);
      if (!transferableStatuses.has(current.status)) {
        throw new ConflictException(
          `Cannot initiate a transfer while payout is ${current.status}`,
        );
      }

      if (String(current.currency || '').trim().toUpperCase() !== 'NGN') {
        throw new BadRequestException(
          'Paystack payouts are only enabled for NGN in this phase',
        );
      }

      const paymentAccount = await (tx as any).storePaymentAccount.findUnique({
        where: { brandId: current.brandId },
      });

      if (!paymentAccount || paymentAccount.status !== 'ACTIVE') {
        throw new BadRequestException(
          'Brand payout account is not active. Sync the brand payment account before initiating payout.',
        );
      }

      if (
        !paymentAccount.transferRecipientCode ||
        !paymentAccount.transferRecipientActive
      ) {
        throw new BadRequestException(
          'Brand payout account does not have an active transfer recipient.',
        );
      }

      await this.assertPayoutSourceReservations(
        tx,
        current.id,
        Number(current.amount ?? 0),
      );

      const transferReference =
        current.providerTransferReference ?? this.buildTransferReference(current.id);

      const providerPayload = await this.callPaystack('/transfer', {
        method: 'POST',
        bodyJson: {
          source: 'balance',
          amount: Math.round(this.roundMoney(Number(current.amount ?? 0)) * 100),
          recipient: paymentAccount.transferRecipientCode,
          reference: transferReference,
          reason: `Threadly payout ${current.id.slice(0, 8).toUpperCase()}`,
          currency: 'NGN',
        },
      });

      const updated = await this.applyProviderTransferSync(
        tx,
        current,
        providerPayload,
        'provider-initiate',
      );

      const otpMode = this.getTransferOtpMode();
      const providerStatus = this.normalizeProviderStatus(
        providerPayload?.status,
      );
      if (otpMode === 'DISABLED' && providerStatus === 'OTP') {
        this.logger.warn(
          `Transfer ${updated.id} returned OTP while PAYSTACK_TRANSFER_OTP_MODE is DISABLED`,
        );
      }

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_PAYOUT_STATUS_UPDATE,
          targetType: 'Payout',
          targetId: payoutId,
          previousState: {
            status: current.status,
            providerTransferCode: current.providerTransferCode ?? null,
            providerTransferReference:
              current.providerTransferReference ?? null,
          },
          newState: {
            status: updated.status,
            providerTransferCode: updated.providerTransferCode ?? null,
            providerTransferReference: updated.providerTransferReference ?? null,
            providerTransferStatus: updated.providerTransferStatus ?? null,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return updated;
    });
  }

  async finalizeTransferOtp(
    payoutId: string,
    otp: string,
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    const cleanOtp = String(otp || '').trim();
    if (!cleanOtp) {
      throw new BadRequestException('OTP is required to finalize this transfer');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.lockPayoutForUpdate(tx, payoutId);

      const current = await tx.payout.findUnique({
        where: { id: payoutId },
        include: this.payoutInclude(),
      });
      if (!current) {
        throw new NotFoundException('Payout not found');
      }

      this.assertOwnership(current.assignedAdminId, actorId, actorRole);

      if (!current.providerTransferCode) {
        throw new BadRequestException(
          'This payout does not have a pending transfer to finalize',
        );
      }

      const providerTransferStatus = this.normalizeProviderStatus(
        current.providerTransferStatus,
      );
      if (providerTransferStatus !== 'OTP') {
        throw new BadRequestException(
          'This payout is not awaiting Paystack OTP finalization',
        );
      }

      const providerPayload = await this.callPaystack(
        '/transfer/finalize_transfer',
        {
          method: 'POST',
          bodyJson: {
            transfer_code: current.providerTransferCode,
            otp: cleanOtp,
          },
        },
      );

      const updated = await this.applyProviderTransferSync(
        tx,
        current,
        providerPayload,
        'provider-finalize',
      );

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_PAYOUT_STATUS_UPDATE,
          targetType: 'Payout',
          targetId: payoutId,
          previousState: {
            status: current.status,
            providerTransferStatus: current.providerTransferStatus ?? null,
          },
          newState: {
            status: updated.status,
            providerTransferStatus: updated.providerTransferStatus ?? null,
            providerTransferCode: updated.providerTransferCode ?? null,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return updated;
    });
  }

  async getProviderStatus(
    payoutId: string,
    actorId: string,
    actorRole: Role,
  ) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      include: this.payoutInclude(),
    });
    if (!payout) throw new NotFoundException('Payout not found');

    this.assertOwnership(payout.assignedAdminId, actorId, actorRole);

    if (!payout.providerTransferCode) {
      throw new BadRequestException('This payout does not have a Paystack transfer code yet');
    }

    const providerPayload = await this.callPaystack(
      `/transfer/${encodeURIComponent(payout.providerTransferCode)}`,
      { method: 'GET' },
    );

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.payout.findUnique({
        where: { id: payoutId },
        include: this.payoutInclude(),
      });
      if (!current) {
        throw new NotFoundException('Payout not found');
      }

      return this.applyProviderTransferSync(
        tx,
        current,
        providerPayload,
        'provider-fetch',
      );
    });
  }

  async handlePaystackWebhook(
    payload: Record<string, any>,
    context: WebhookContext,
  ): Promise<void> {
    const receipt = await this.recordPaystackWebhookReceipt(payload, context);
    if (!receipt || receipt.processedAt) {
      return;
    }

    await this.processQueuedPaystackWebhook({
      payload,
      providerEventKey: receipt.providerEventKey,
      payoutId: receipt.payoutId,
      providerEventType: receipt.providerEventType,
    });
  }

  async enqueuePaystackWebhook(
    payload: Record<string, any>,
    context: WebhookContext,
  ): Promise<void> {
    const receipt = await this.recordPaystackWebhookReceipt(payload, context);
    if (!receipt || receipt.processedAt) {
      return;
    }

    await this.webhookEventsQueue.enqueuePayoutWebhook({
      payload,
      providerEventKey: receipt.providerEventKey,
      payoutId: receipt.payoutId,
      providerEventType: receipt.providerEventType,
    });
  }

  async processQueuedPaystackWebhook(
    job: PayoutWebhookProcessJob,
  ): Promise<void> {
    const providerPayload = this.asObject(job.payload?.data) ?? job.payload;

    await this.prisma.$transaction(async (tx) => {
      const current = await tx.payout.findUnique({
        where: { id: job.payoutId },
        include: this.payoutInclude(),
      });
      if (!current) {
        await (tx as any).payoutEvent.updateMany({
          where: { providerEventKey: job.providerEventKey },
          data: { processedAt: new Date() },
        });
        return;
      }

      await this.applyProviderTransferSync(
        tx,
        current,
        providerPayload,
        'provider-webhook',
        job.providerEventType,
      );

      await (tx as any).payoutEvent.updateMany({
        where: { providerEventKey: job.providerEventKey },
        data: { processedAt: new Date() },
      });
    });
  }

  private async recordPaystackWebhookReceipt(
    payload: Record<string, any>,
    context: WebhookContext,
  ) {
    if (!this.verifyPaystackWebhookOrigin(context)) {
      this.logger.warn('Rejected payout webhook due to origin verification failure');
      return null;
    }

    const eventType = String(payload?.event || '').trim();
    if (!eventType.startsWith('transfer.')) {
      return null;
    }

    const providerPayload = this.asObject(payload?.data) ?? payload;
    const transferCode = this.extractTransferCode(providerPayload);
    const transferReference = this.extractTransferReference(providerPayload);

    if (!transferCode && !transferReference) {
      this.logger.warn(`Rejected payout webhook ${eventType}: missing transfer reference`);
      return null;
    }

    const payout = await this.prisma.payout.findFirst({
      where: {
        OR: [
          ...(transferCode ? [{ providerTransferCode: transferCode }] : []),
          ...(transferReference ? [{ providerTransferReference: transferReference }] : []),
          ...(transferReference ? [{ gatewayReference: transferReference }] : []),
        ],
      },
      include: this.payoutInclude(),
    });

    if (!payout) {
      this.logger.warn(
        `Payout webhook ${eventType}: unknown transfer (${transferCode ?? transferReference})`,
      );
      return null;
    }

    const providerEventKey = this.computeProviderEventKey(
      eventType,
      providerPayload,
      payout.id,
    );

    if (!providerEventKey) {
      this.logger.warn(`Payout webhook ${eventType}: unable to compute event key`);
      return null;
    }

    try {
      await (this.prisma as any).payoutEvent.create({
        data: {
          id: uuidv4(),
          payoutId: payout.id,
          type: 'WEBHOOK_RECEIVED',
          source: 'webhook-receipt',
          providerEventKey,
          providerEventType: eventType,
          providerEventReceivedAt: new Date(),
          payload,
        },
      });
    } catch (error: any) {
      const message = String(error?.message || '');
      if (message.includes('providerEventKey') || message.includes('Unique constraint')) {
        const existing = await (this.prisma as any).payoutEvent.findFirst({
          where: { providerEventKey },
          select: { processedAt: true },
        });
        return {
          payoutId: payout.id,
          providerEventKey,
          providerEventType: eventType,
          processedAt: existing?.processedAt ?? null,
        };
      }
      throw error;
    }

    return {
      payoutId: payout.id,
      providerEventKey,
      providerEventType: eventType,
      processedAt: null,
    };
  }

  private payoutInclude() {
    return {
      brand: { select: { id: true, name: true } },
      assignedAdmin: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
      approvedBy: {
        select: { id: true, firstName: true, lastName: true, email: true },
      },
    };
  }

  private summarizeStorePaymentAccount(account: any) {
    return {
      id: account?.id ?? null,
      status: account?.status ?? 'PENDING_SETUP',
      provider: account?.provider ?? 'PAYSTACK',
      bankName: account?.bankName ?? null,
      accountName: account?.accountName ?? null,
      maskedAccountNumber:
        account?.accountNumberLast4 != null
          ? `******${String(account.accountNumberLast4)}`
          : null,
      subaccountCode: account?.subaccountCode ?? null,
      transferRecipientCode: account?.transferRecipientCode ?? null,
      transferRecipientActive: Boolean(account?.transferRecipientActive),
      lastSyncError: account?.lastSyncError ?? null,
      subaccountLastSyncAt: account?.subaccountLastSyncAt ?? null,
      transferRecipientLastSyncAt: account?.transferRecipientLastSyncAt ?? null,
      updatedAt: account?.updatedAt ?? null,
    };
  }

  private async applyProviderTransferSync(
    tx: any,
    payout: any,
    providerPayload: Record<string, any>,
    source:
      | 'provider-initiate'
      | 'provider-finalize'
      | 'provider-fetch'
      | 'provider-webhook',
    providerEventType?: string,
  ) {
    const now = new Date();
    const nextStatus = this.mapProviderTransferStatus(
      providerEventType,
      providerPayload?.status,
    );
    const failureMessage = this.extractTransferFailureMessage(providerPayload);
    const nextData: Record<string, unknown> = {
      provider: 'PAYSTACK',
      providerRecipientCode:
        this.extractRecipientCode(providerPayload) ?? payout.providerRecipientCode ?? null,
      providerRecipientId:
        this.extractRecipientId(providerPayload) ?? payout.providerRecipientId ?? null,
      providerTransferCode:
        this.extractTransferCode(providerPayload) ?? payout.providerTransferCode ?? null,
      providerTransferId:
        this.extractTransferId(providerPayload) ?? payout.providerTransferId ?? null,
      providerTransferReference:
        this.extractTransferReference(providerPayload) ??
        payout.providerTransferReference ??
        null,
      providerTransferStatus:
        this.normalizeProviderStatus(providerPayload?.status) ??
        payout.providerTransferStatus ??
        null,
      providerTransferFailureCode:
        this.extractTransferFailureCode(providerPayload) ??
        payout.providerTransferFailureCode ??
        null,
      providerTransferFailureMessage: failureMessage ?? null,
      providerTransferPayload: providerPayload,
      gatewayReference:
        this.extractTransferReference(providerPayload) ?? payout.gatewayReference ?? null,
    };

    if (!payout.providerTransferInitiatedAt) {
      nextData.providerTransferInitiatedAt = now;
    }

    if (nextStatus === PayoutStatus.PROCESSING) {
      nextData.status = PayoutStatus.PROCESSING;
      nextData.processedAt = payout.processedAt ?? now;
      nextData.statusReason = null;
    }

    if (nextStatus === PayoutStatus.PAID) {
      nextData.status = PayoutStatus.PAID;
      nextData.paidAt = payout.paidAt ?? now;
      nextData.providerTransferFinalizedAt = now;
      nextData.failureReason = null;
      nextData.statusReason = null;
    }

    if (nextStatus === PayoutStatus.FAILED) {
      nextData.status = PayoutStatus.FAILED;
      nextData.failureReason = failureMessage || 'Paystack reported that the payout failed';
      nextData.statusReason = nextData.failureReason;
    }

    if (nextStatus === PayoutStatus.RECONCILIATION_REVIEW) {
      nextData.status = PayoutStatus.RECONCILIATION_REVIEW;
      nextData.providerTransferReversedAt = now;
      nextData.statusReason =
        failureMessage || 'Paystack reported that the payout transfer was reversed';
    }

    const updated = await tx.payout.update({
      where: { id: payout.id },
      data: nextData,
      include: this.payoutInclude(),
    });

    await this.applyPayoutStatusSideEffects(
      tx,
      payout,
      updated,
      now,
      updated.status,
    );

    await this.createPayoutEvent(tx, {
      payoutId: payout.id,
      type: `STATUS_${updated.status}`,
      source,
      providerEventType:
        providerEventType ?? this.normalizeProviderStatus(providerPayload?.status),
      providerEventReceivedAt: source === 'provider-webhook' ? now : null,
      processedAt: now,
      payload: providerPayload,
    });

    return updated;
  }

  private async applyPayoutStatusSideEffects(
    tx: any,
    previous: any,
    current: any,
    now: Date,
    nextStatus: PayoutStatus,
  ) {
    if (nextStatus === PayoutStatus.PAID && previous.status !== PayoutStatus.PAID) {
      const [linkedAllocationSummary, linkedLedgerSourceSummary] = await Promise.all([
        tx.customOrderLedgerAllocation.aggregate({
          where: {
            payoutId: current.id,
            status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
            paidOutAt: null,
          },
          _sum: { netBrandAmount: true },
          _count: { id: true },
        }),
        (tx as any).payoutLedgerSourceAllocation.aggregate({
          where: { payoutId: current.id },
          _sum: { amount: true },
          _count: { id: true },
        }),
      ]);

      const expectedNetAmount = this.roundMoney(
        Number(linkedAllocationSummary._sum.netBrandAmount ?? 0) +
          Number(linkedLedgerSourceSummary._sum.amount ?? 0),
      );
      const payoutAmount = this.roundMoney(Number(current.amount ?? 0));

      if (
        ((linkedAllocationSummary._count?.id ?? 0) > 0 ||
          (linkedLedgerSourceSummary._count?.id ?? 0) > 0) &&
        Math.abs(expectedNetAmount - payoutAmount) >= 0.01
      ) {
        throw new ConflictException(
          'Payout amount no longer matches the linked payout source reservations',
        );
      }

      await tx.customOrderLedgerAllocation.updateMany({
        where: {
          payoutId: current.id,
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          paidOutAt: null,
        },
        data: {
          status: CustomOrderLedgerAllocationStatus.PAID_OUT,
          paidOutAt: now,
        },
      });

      await this.ledgerService.postPayoutDisbursed(tx, current);
      await this.financialDocumentsService.issuePayoutSettlementStatement(tx, {
        payoutId: current.id,
        brandId: current.brandId,
        brandName: current.brand?.name ?? null,
        currency: current.currency,
        amount: Number(current.amount),
      });
      await this.financialDocumentsService.issueCommissionInvoice(tx, {
        payoutId: current.id,
        brandId: current.brandId,
        brandName: current.brand?.name ?? null,
        currency: current.currency,
        amount: Number(current.amount),
      });
    }

    if (nextStatus === PayoutStatus.REJECTED && previous.status !== PayoutStatus.REJECTED) {
      await tx.customOrderLedgerAllocation.updateMany({
        where: {
          payoutId: current.id,
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          paidOutAt: null,
        },
        data: {
          payoutId: null,
        },
      });
    }
  }

  private async createPayoutEvent(
    tx: any,
    params: {
      payoutId: string;
      type: string;
      source: string;
      providerEventType?: string | null;
      providerEventReceivedAt?: Date | null;
      processedAt?: Date | null;
      payload?: Record<string, any> | null;
    },
  ) {
    await (tx as any).payoutEvent.create({
      data: {
        id: uuidv4(),
        payoutId: params.payoutId,
        type: params.type,
        source: params.source,
        providerEventType: params.providerEventType ?? null,
        providerEventReceivedAt: params.providerEventReceivedAt ?? null,
        processedAt: params.processedAt ?? null,
        payload: params.payload ?? null,
      },
    });
  }

  private async lockPayoutForUpdate(tx: any, payoutId: string) {
    await tx.$queryRaw`SELECT "id" FROM "Payout" WHERE "id" = ${payoutId} FOR UPDATE`;
  }

  private buildTransferReference(payoutId: string) {
    return `threadly-payout-${payoutId}`.toLowerCase();
  }

  private isPayoutTransferExecutionEnabled() {
    const value = String(
      process.env.PAYSTACK_PAYOUT_TRANSFERS_ENABLED ?? 'true',
    )
      .trim()
      .toLowerCase();
    return !['0', 'false', 'no', 'off'].includes(value);
  }

  private getTransferOtpMode(): 'DISABLED' | 'REQUIRED' {
    const value = String(process.env.PAYSTACK_TRANSFER_OTP_MODE ?? 'DISABLED')
      .trim()
      .toUpperCase();
    return value === 'REQUIRED' ? 'REQUIRED' : 'DISABLED';
  }

  private async assertPayoutSourceReservations(
    tx: any,
    payoutId: string,
    payoutAmount: number,
  ) {
    const [customOrderAllocations, standardOrderAllocations] = await Promise.all([
      tx.customOrderLedgerAllocation.aggregate({
        where: {
          payoutId,
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          paidOutAt: null,
        },
        _sum: { netBrandAmount: true },
        _count: { id: true },
      }),
      (tx as any).payoutLedgerSourceAllocation.aggregate({
        where: { payoutId },
        _sum: { amount: true },
        _count: { id: true },
      }),
    ]);

    const linkedSourcesCount =
      Number(customOrderAllocations?._count?.id ?? 0) +
      Number(standardOrderAllocations?._count?.id ?? 0);
    if (linkedSourcesCount === 0) {
      throw new ConflictException(
        'This payout no longer has active source reservations',
      );
    }

    const linkedSourcesTotal = this.roundMoney(
      Number(customOrderAllocations?._sum?.netBrandAmount ?? 0) +
        Number(standardOrderAllocations?._sum?.amount ?? 0),
    );
    const expectedAmount = this.roundMoney(Number(payoutAmount ?? 0));
    if (Math.abs(linkedSourcesTotal - expectedAmount) >= 0.01) {
      throw new ConflictException(
        'Payout amount no longer matches reserved payout source allocations',
      );
    }
  }

  private getRequiredPaystackSecret() {
    const secret = String(process.env.PAYSTACK_SECRET_KEY ?? '').trim();
    if (!secret) {
      throw new BadRequestException('PAYSTACK_SECRET_KEY is required for payout execution');
    }
    return secret;
  }

  private async callPaystack(
    path: string,
    init?: RequestInit & { bodyJson?: Record<string, unknown> },
  ) {
    const secret = this.getRequiredPaystackSecret();
    const { bodyJson, headers, ...rest } = init ?? {};
    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      Accept: 'application/json',
      ...(headers as Record<string, string> | undefined),
    };
    if (bodyJson) {
      requestHeaders['Content-Type'] = 'application/json';
    }

    const response = await fetch(`https://api.paystack.co${path}`, {
      ...rest,
      headers: requestHeaders,
      body: bodyJson ? JSON.stringify(bodyJson) : rest.body,
    });

    let payload: Record<string, any> | null = null;
    try {
      payload = (await response.json()) as Record<string, any>;
    } catch {
      payload = null;
    }

    if (!response.ok || payload?.status === false || !payload?.data) {
      throw new BadRequestException(
        String(payload?.message || 'Paystack payout request failed'),
      );
    }

    return (payload.data ?? payload) as Record<string, any>;
  }

  private verifyPaystackWebhookOrigin(context: WebhookContext) {
    if (!this.isAllowedPaystackWebhookIp(context)) {
      return false;
    }
    return this.verifyPaystackWebhookSignature(context);
  }

  private verifyPaystackWebhookSignature(context: WebhookContext) {
    const secret = this.getRequiredPaystackSecret();
    const signature = this.getHeader(context.headers, 'x-paystack-signature');
    if (!signature || !context.rawBody) {
      return false;
    }

    const expected = createHmac('sha512', secret)
      .update(context.rawBody)
      .digest('hex');

    return this.safeCompare(signature, expected);
  }

  private isAllowedPaystackWebhookIp(context: WebhookContext) {
    const disabled = String(
      process.env.PAYSTACK_WEBHOOK_IP_ALLOWLIST_DISABLED ?? '',
    )
      .trim()
      .toLowerCase();
    if (['1', 'true', 'yes'].includes(disabled)) {
      return true;
    }

    const configuredIps = String(process.env.PAYSTACK_WEBHOOK_IP_ALLOWLIST ?? '')
      .split(',')
      .map((value) => this.normalizeIp(value))
      .filter((value): value is string => Boolean(value));
    const allowlist = new Set<string>(
      configuredIps.length > 0 ? configuredIps : [...PAYSTACK_WEBHOOK_IPS],
    );
    const candidates = this.extractRequestIps(context);

    return candidates.some((candidate) => allowlist.has(candidate));
  }

  private extractRequestIps(context: WebhookContext) {
    const forwarded = this.getHeader(context.headers, 'x-forwarded-for');
    const forwardedIps = String(forwarded ?? '')
      .split(',')
      .map((value) => this.normalizeIp(value))
      .filter((value): value is string => Boolean(value));
    const directIp = this.normalizeIp(context.remoteAddress);
    return Array.from(new Set([...forwardedIps, ...(directIp ? [directIp] : [])]));
  }

  private normalizeIp(value: string | null | undefined) {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      return null;
    }
    if (normalized.startsWith('::ffff:')) {
      return normalized.slice(7);
    }
    return normalized;
  }

  private getHeader(headers: Record<string, any>, name: string) {
    const target = name.toLowerCase();
    for (const [headerName, value] of Object.entries(headers ?? {})) {
      if (headerName.toLowerCase() === target) {
        return Array.isArray(value) ? String(value[0] ?? '').trim() : String(value ?? '').trim();
      }
    }
    return null;
  }

  private safeCompare(left: string, right: string) {
    const leftBuffer = Buffer.from(String(left || '').trim());
    const rightBuffer = Buffer.from(String(right || '').trim());
    if (leftBuffer.length === 0 || rightBuffer.length === 0) {
      return false;
    }
    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
  }

  private computeProviderEventKey(
    providerEventType: string | null | undefined,
    payload: Record<string, any>,
    payoutId: string,
  ) {
    const parts = [
      'PAYSTACK',
      payoutId,
      providerEventType,
      this.extractTransferCode(payload),
      this.extractTransferReference(payload),
      this.normalizeProviderStatus(payload?.status),
      payload?.updatedAt ?? payload?.createdAt ?? payload?.transferred_at ?? null,
    ]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);

    return parts.length > 0 ? parts.join(':') : null;
  }

  private mapProviderTransferStatus(
    providerEventType: string | null | undefined,
    rawStatus: string | null | undefined,
  ): PayoutStatus {
    const event = String(providerEventType || '').trim().toLowerCase();
    if (event === 'transfer.success') {
      return PayoutStatus.PAID;
    }
    if (event === 'transfer.failed') {
      return PayoutStatus.FAILED;
    }
    if (event === 'transfer.reversed') {
      return PayoutStatus.RECONCILIATION_REVIEW;
    }

    switch (String(rawStatus || '').trim().toLowerCase()) {
      case 'success':
        return PayoutStatus.PAID;
      case 'failed':
      case 'failure':
      case 'error':
        return PayoutStatus.FAILED;
      case 'reversed':
      case 'reversal':
        return PayoutStatus.RECONCILIATION_REVIEW;
      case 'otp':
      case 'pending':
      case 'processing':
      default:
        return PayoutStatus.PROCESSING;
    }
  }

  private normalizeProviderStatus(value: unknown) {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized.toUpperCase() : null;
  }

  private extractTransferCode(payload: Record<string, any>) {
    const value = payload?.transfer_code;
    return value != null ? String(value).trim() || null : null;
  }

  private extractTransferReference(payload: Record<string, any>) {
    const value = payload?.reference;
    return value != null ? String(value).trim() || null : null;
  }

  private extractTransferId(payload: Record<string, any>) {
    const value = payload?.id ?? payload?.request;
    return value != null ? String(value).trim() || null : null;
  }

  private extractRecipientCode(payload: Record<string, any>) {
    const value =
      payload?.recipient?.recipient_code ??
      payload?.recipient_code ??
      (typeof payload?.recipient === 'string' ? payload.recipient : null);
    return value != null ? String(value).trim() || null : null;
  }

  private extractRecipientId(payload: Record<string, any>) {
    const value = payload?.recipient?.id;
    return value != null ? String(value).trim() || null : null;
  }

  private extractTransferFailureCode(payload: Record<string, any>) {
    const value = payload?.failure_code ?? payload?.status ?? null;
    return value != null ? String(value).trim() || null : null;
  }

  private extractTransferFailureMessage(payload: Record<string, any>) {
    if (Array.isArray(payload?.failures) && payload.failures.length > 0) {
      return payload.failures
        .map((entry: any) => String(entry?.message ?? entry?.reason ?? entry ?? '').trim())
        .filter(Boolean)
        .join('; ');
    }

    const value =
      payload?.failure_reason ??
      payload?.message ??
      payload?.recipient?.message ??
      null;
    return value != null ? String(value).trim() || null : null;
  }

  private asObject(value: unknown) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : null;
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private assertOwnership(
    assignedAdminId: string | null,
    actorId: string,
    actorRole: Role,
  ) {
    if (actorRole === Role.SuperAdmin) {
      return;
    }

    if (!assignedAdminId) {
      throw new ForbiddenException('Payout must be claimed before it can be updated');
    }

    if (assignedAdminId !== actorId) {
      throw new ForbiddenException('Payout is assigned to another admin');
    }
  }
}
