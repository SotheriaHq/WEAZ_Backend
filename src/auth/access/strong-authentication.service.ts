import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomInt, randomUUID } from 'crypto';
import { Secret, TOTP } from 'otpauth';
import type { Prisma, SecurityFactor } from '@prisma/client';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { PrismaService } from 'src/prisma/prisma.service';
import { EmailService } from 'src/email/email.service';
import { PasswordService } from '../helper/password.service';
import { lockCurrentSecurityActor, type SecurityActor } from './security-actor';
import {
  decryptFactor,
  encryptFactor,
  matchesOperationDigest,
  operationDigest,
  randomSecuritySecret,
  secretDigest,
} from './security-factor-crypto';
import { STRONG_READ_WINDOW_MS } from './access-policy.engine';
import { withSecurityTransaction } from './transactional-enforcement';
import {
  requireMfaEnrollmentAction,
  requireMfaManagementAction,
} from './mfa-enrollment-authority';
import { getLiveSecurityContext } from './security-request-context';
import { Cron, CronExpression } from '@nestjs/schedule';
import { mfaPasswordProof } from './mfa-password-proof';
import { completeMfaRecovery, requireApprovedMfaRecovery } from './mfa-recovery-state';
import { passkeyConfiguration } from './passkey-configuration';
import { boundedPasskeyResponse } from './passkey-response';

@Injectable()
export class StrongAuthenticationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly passwords: PasswordService,
    private readonly email: EmailService,
  ) {}

  private passkeyConfig() {
    return passkeyConfiguration(this.config);
  }
  private totp(secret: string, label = 'WIEZ') {
    return new TOTP({
      issuer: 'WIEZ',
      label,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret),
    });
  }
  private async primaryProof(actor: SecurityActor, password: string) {
    return mfaPasswordProof(this.prisma, this.passwords, actor, password);
  }
  private async checkEnrollment(
    tx: Prisma.TransactionClient,
    actor: SecurityActor,
    passwordHash: string,
    kind: 'totp' | 'passkeys',
    enrollmentProof?: string,
    replacesFactorId?: string,
  ) {
    const current = await lockCurrentSecurityActor(tx, actor);
    if (current.user.password !== passwordHash)
      throw new UnauthorizedException(
        'Account security changed. Sign in again.',
      );
    const count = await tx.securityFactor.count({
      where: { userId: actor.id, revokedAt: null, verifiedAt: { not: null } },
    });
    if (count >= 10 && !replacesFactorId)
      throw new BadRequestException(
        'Remove an unused authentication method before adding another.',
      );
    if (
      count ||
      getLiveSecurityContext()?.operation.policy.sensitivity ===
        'CRITICAL_CHANGE'
    )
      requireMfaEnrollmentAction(actor, kind, replacesFactorId);
    if (!count) {
      const [id, secret, extra] = (enrollmentProof ?? '').split('.');
      if (!id || !secret || extra)
        throw new PreconditionFailedException({
          code: 'ENROLLMENT_EMAIL_REQUIRED',
          message:
            'Confirm the code sent to your verified email before setting up your first authentication method.',
        });
      const consumed = await tx.securityStepUpChallenge.updateMany({
        where: {
          id,
          userId: actor.id,
          sessionId: actor.sid,
          authVersion: actor.authVersion,
          operationDigest: 'BOOTSTRAP',
          proofHash: secretDigest(secret),
          verifiedAt: { not: null },
          usedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1)
        throw new BadRequestException(
          'Enrollment approval expired or was already used. Request a new email code.',
        );
    }
    return current;
  }
  async requestEnrollmentEmail(actor: SecurityActor, password: string) {
    const passwordHash = await this.primaryProof(actor, password);
    const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
    const nonce = randomSecuritySecret();
    return this.prisma.$transaction(async (tx) => {
      const { user } = await lockCurrentSecurityActor(tx, actor);
      if (user.password !== passwordHash)
        throw new UnauthorizedException(
          'Account security changed. Sign in again.',
        );
      const fullUser = await tx.user.findUniqueOrThrow({
        where: { id: actor.id },
        select: { isEmailVerified: true },
      });
      if (!fullUser.isEmailVerified)
        throw new BadRequestException(
          'Verify your account email before enabling stronger authentication.',
        );
      if (
        await tx.securityFactor.count({
          where: {
            userId: actor.id,
            revokedAt: null,
            verifiedAt: { not: null },
          },
        })
      ) {
        throw new BadRequestException(
          'Verify an existing authentication method before adding another.',
        );
      }
      const recent = await tx.securityStepUpChallenge.count({
        where: {
          userId: actor.id,
          operationDigest: 'BOOTSTRAP',
          createdAt: { gt: new Date(Date.now() - 900_000) },
        },
      });
      if (recent >= 3)
        throw new BadRequestException(
          'Too many enrollment requests. Wait 15 minutes before trying again.',
        );
      const id = randomUUID();
      await tx.securityStepUpChallenge.create({
        data: {
          id,
          userId: actor.id,
          sessionId: actor.sid,
          authVersion: actor.authVersion,
          operationDigest: 'BOOTSTRAP',
          method: 'POST',
          route: 'mfa-enrollment',
          sensitivity: 'CRITICAL_CHANGE',
          nonce,
          proofHash: operationDigest(this.config, {
            purpose: 'MFA_ENROLLMENT',
            userId: actor.id,
            sessionId: actor.sid,
            nonce,
            code,
          }),
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      const text = `Your WIEZ authentication setup code is ${code}. It expires in 10 minutes. Use it only if you are setting up an authenticator or passkey. If this was not you, change your password and revoke other sessions.`;
      const queued = await this.email.send(
        user.email,
        'Confirm your WIEZ authentication setup',
        `<p>${text}</p>`,
        text,
        {
          recipientUserId: actor.id,
          scenarioKey: 'auth.mfa.enrollment',
          priority: 'P0_SECURITY',
          idempotencyKey: `mfa-enroll:${id}`,
        },
        tx,
      );
      if (!['QUEUED', 'SENT'].includes(queued.dispatchStatus))
        throw new ServiceUnavailableException(
          'We could not send the setup code. Please retry later.',
        );
      return { challengeId: id, expiresInSeconds: 600 };
    });
  }
  async confirmEnrollmentEmail(actor: SecurityActor, id: string, code: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      await lockCurrentSecurityActor(tx, actor);
      const challenge = await this.liveChallenge(tx, actor, id);
      if (challenge.operationDigest !== 'BOOTSTRAP')
        throw new BadRequestException('Invalid enrollment challenge.');
      await tx.securityStepUpChallenge.update({
        where: { id },
        data: { attempts: { increment: 1 } },
      });
      if (
        !challenge.proofHash ||
        !/^\d{8}$/.test(code) ||
        !matchesOperationDigest(this.config, challenge.proofHash, {
          purpose: 'MFA_ENROLLMENT',
          userId: actor.id,
          sessionId: actor.sid,
          nonce: challenge.nonce,
          code,
        })
      )
        return null;
      const secret = randomSecuritySecret();
      await tx.securityStepUpChallenge.update({
        where: { id },
        data: { verifiedAt: new Date(), proofHash: secretDigest(secret) },
      });
      return { enrollmentProof: `${id}.${secret}` };
    });
    if (!result)
      throw new BadRequestException(
        'The setup code is invalid. Check your email and try again.',
      );
    return result;
  }
  async status(actor: SecurityActor) {
    let passkeys = { webConfigured: false, androidConfigured: false };
    try { const configured = this.passkeyConfig(); passkeys = { webConfigured: true, androidConfigured: configured.androidConfigured }; }
    catch (error) { if (!(error instanceof ServiceUnavailableException)) throw error; }
    const [factors, recoveryCodes, user] = await Promise.all([
      this.prisma.securityFactor.findMany({
        where: { userId: actor.id, revokedAt: null, verifiedAt: { not: null } },
        select: {
          id: true,
          kind: true,
          label: true,
          verifiedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.prisma.securityRecoveryCode.count({
        where: { userId: actor.id, usedAt: null },
      }),
      this.prisma.user.findUnique({
        where: { id: actor.id },
        select: { password: true, passwordCredentialStatus: true, isEmailVerified: true },
      }),
    ]);
    return {
      factors,
      recoveryCodesRemaining: recoveryCodes,
      readVerificationSeconds: STRONG_READ_WINDOW_MS / 1000,
      passkeys,
      setup: {
        hasPassword: Boolean(user?.password && user.passwordCredentialStatus === 'ENABLED'),
        emailVerified: Boolean(user?.isEmailVerified),
      },
    };
  }
  async beginTotp(
    actor: SecurityActor,
    password: string,
    enrollmentProof?: string,
    replacesFactorId?: string,
  ) {
    const passwordHash = await this.primaryProof(actor, password);
    const factorId = randomUUID();
    const secret = new Secret({ size: 20 }).base32;
    const sealed = encryptFactor(this.config, actor.id, factorId, secret);
    return withSecurityTransaction(this.prisma, async (tx) => {
      const { user } = await this.checkEnrollment(
        tx,
        actor,
        passwordHash,
        'totp',
        enrollmentProof,
        replacesFactorId,
      );
      if (
        replacesFactorId &&
        !(await tx.securityFactor.findFirst({
          where: {
            id: replacesFactorId,
            userId: actor.id,
            kind: 'TOTP',
            revokedAt: null,
            verifiedAt: { not: null },
          },
          select: { id: true },
        }))
      )
        throw new NotFoundException(
          'The authenticator to replace is no longer available.',
        );
      if (
        !replacesFactorId &&
        (await tx.securityFactor.count({
          where: {
            userId: actor.id,
            kind: 'TOTP',
            verifiedAt: { not: null },
            revokedAt: null,
          },
        }))
      ) {
        throw new ConflictException(
          'An authenticator app is already enabled. Add a passkey or use your existing app.',
        );
      }
      await tx.securityFactor.deleteMany({
        where: { userId: actor.id, kind: 'TOTP', verifiedAt: null },
      });
      await tx.securityFactor.create({
        data: {
          id: factorId,
          userId: actor.id,
          kind: 'TOTP',
          label: 'Authenticator app',
          createdBySessionId: actor.sid,
          replacesFactorId: replacesFactorId ?? null,
          secretCiphertext: sealed,
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      return {
        factorId,
        secret,
        uri: this.totp(secret, user.username).toString(),
        expiresInSeconds: 600,
      };
    });
  }
  private acceptedTotpStep(
    ciphertext: string,
    factorId: string,
    actor: SecurityActor,
    code: string,
    lastUsedStep: bigint,
  ) {
    if (!/^\d{6}$/.test(code)) return null;
    const totp = this.totp(
      decryptFactor(this.config, actor.id, factorId, ciphertext),
    );
    const timestamp = Date.now();
    const delta = totp.validate({ token: code, timestamp, window: 1 });
    const step =
      delta === null ? null : BigInt(totp.counter({ timestamp }) + delta);
    return step !== null && step > lastUsedStep ? step : null;
  }
  private async recoveryCodes(
    tx: Prisma.TransactionClient,
    userId: string,
    factorId: string,
  ) {
    const codes = Array.from({ length: 10 }, () =>
      randomBytes(16).toString('hex').toUpperCase().match(/.{4}/g)!.join('-'),
    );
    await tx.securityRecoveryCode.deleteMany({ where: { userId } });
    await tx.securityRecoveryCode.createMany({
      data: codes.map((code) => ({
        id: randomUUID(),
        userId,
        factorId,
        codeHash: secretDigest(
          `wiez:recovery:${userId}:${code.replaceAll('-', '')}`,
        ),
      })),
    });
    return codes;
  }
  private async markStrong(tx: Prisma.TransactionClient, actor: SecurityActor) {
    const now = new Date();
    await tx.refreshToken.update({
      where: { id: actor.sid },
      data: {
        strongAuthenticatedAt: now,
        strongAuthVersion: actor.authVersion,
        riskState: 'NORMAL',
        riskScore: 0,
        riskReasons: [],
        riskObservedAt: now,
      },
    });
  }

  private async invalidateStrongAuthority(
    tx: Prisma.TransactionClient,
    actor: SecurityActor,
  ) {
    const now = new Date();
    await tx.refreshToken.updateMany({
      where: { userId: actor.id },
      data: { strongAuthenticatedAt: null, strongAuthVersion: null },
    });
    await tx.securityStepUpChallenge.updateMany({
      where: { userId: actor.id, expiresAt: { gt: now }, usedAt: null },
      data: { usedAt: now, proofHash: null },
    });
    await tx.securityStepUpChallenge.updateMany({
      where: {
        userId: actor.id,
        expiresAt: { gt: now },
        proofHash: { not: null },
      },
      data: { proofHash: null },
    });
    await tx.securityFactor.deleteMany({
      where: { userId: actor.id, verifiedAt: null },
    });
  }

  private async notifyFactorChange(
    tx: Prisma.TransactionClient,
    actor: SecurityActor,
    eventId: string,
    description: string,
  ) {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: actor.id },
      select: { email: true },
    });
    const text = `${description} If this was not you, change your WIEZ password and revoke other sessions in Settings. Never share authentication codes or recovery codes.`;
    const queued = await this.email.send(
      user.email,
      'Your WIEZ sign-in security changed',
      `<p>${text}</p>`,
      text,
      {
        recipientUserId: actor.id,
        scenarioKey: 'auth.mfa.changed',
        priority: 'P0_SECURITY',
        idempotencyKey: `mfa-change:${eventId}`,
      },
      tx,
    );
    if (!['QUEUED', 'SENT', 'SKIPPED'].includes(queued.dispatchStatus))
      throw new ServiceUnavailableException(
        'The security notice could not be saved. No authentication change was committed.',
      );
  }

  private async finishFactorConfirmation(
    tx: Prisma.TransactionClient,
    actor: SecurityActor,
    factor: SecurityFactor,
    attributes: Prisma.SecurityFactorUpdateInput,
  ) {
    if (factor.recoveryRequestId) {
      const { session } = await lockCurrentSecurityActor(tx, actor);
      await completeMfaRecovery(tx, actor, factor.recoveryRequestId, factor.id, session.parentSessionId);
    }
    const active = await tx.securityFactor.findMany({
      where: { userId: actor.id, revokedAt: null, verifiedAt: { not: null } },
      select: { id: true, kind: true },
      take: 11,
    });
    const replacing = factor.replacesFactorId
      ? active.find(
          (item) =>
            item.id === factor.replacesFactorId &&
            item.kind === 'TOTP' &&
            factor.kind === 'TOTP',
        )
      : null;
    if (factor.replacesFactorId && !replacing)
      throw new ConflictException(
        'The original authenticator changed. Start replacement again.',
      );
    if (active.length - (replacing ? 1 : 0) >= 10)
      throw new ConflictException(
        'The account already has ten verified authentication methods.',
      );
    if (replacing)
      await tx.securityFactor.update({
        where: { id: replacing.id },
        data: { revokedAt: new Date(), secretCiphertext: null },
      });
    await tx.securityFactor.update({
      where: { id: factor.id },
      data: { ...attributes, verifiedAt: new Date(), expiresAt: null },
    });
    await this.invalidateStrongAuthority(tx, actor);
    await this.markStrong(tx, actor);
    const recoveryCodes =
      !active.length ||
      !(await tx.securityRecoveryCode.count({
        where: { userId: actor.id, usedAt: null },
      }))
        ? await this.recoveryCodes(tx, actor.id, factor.id)
        : [];
    await this.notifyFactorChange(
      tx,
      actor,
      `${factor.id}:verified`,
      factor.recoveryRequestId
        ? 'Your account recovery completed after two independent approvals and verification of your replacement authenticator. Earlier methods and other sessions were retired.'
        : replacing
        ? 'Your authenticator was replaced after the new authenticator was verified.'
        : 'A verified sign-in method was added to your WIEZ account.',
    );
    return { recoveryCodes };
  }
  async confirmTotp(actor: SecurityActor, factorId: string, code: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      await lockCurrentSecurityActor(tx, actor);
      const factor = await tx.securityFactor.findFirst({
        where: {
          id: factorId,
          userId: actor.id,
          kind: 'TOTP',
          revokedAt: null,
          verifiedAt: null,
          createdBySessionId: actor.sid,
          expiresAt: { gt: new Date() },
        },
      });
      if (!factor?.secretCiphertext)
        throw new BadRequestException(
          'Authenticator setup expired. Start setup again.',
        );
      const step = this.acceptedTotpStep(
        factor.secretCiphertext,
        factor.id,
        actor,
        code,
        factor.lastUsedStep,
      );
      if (step === null) return null;
      return this.finishFactorConfirmation(tx, actor, factor, {
        lastUsedStep: step,
      });
    });
    if (!result)
      throw new BadRequestException(
        'The verification code is invalid or already used. Wait for the next code.',
      );
    return result;
  }
  async beginRecoveryTotp(actor: SecurityActor, recoveryId: string, password: string, enrollmentProof: string) {
    const hash = await this.primaryProof(actor, password);
    const [proofId, proofSecret, extra] = enrollmentProof.split('.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(proofId ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(proofSecret ?? '') || extra !== undefined)
      throw new BadRequestException('Confirm the recovery email code before starting a replacement.');
    const factorId = randomUUID(), secret = new Secret({ size: 20 }).base32;
    const ciphertext = encryptFactor(this.config, actor.id, factorId, secret);
    return this.prisma.$transaction(async tx => {
      const { user } = await lockCurrentSecurityActor(tx, actor);
      if (user.password !== hash) throw new UnauthorizedException('Account security changed. Sign in again.');
      const recovery = await requireApprovedMfaRecovery(tx, actor, recoveryId);
      const consumed = await tx.securityStepUpChallenge.updateMany({ where: { id: proofId, userId: actor.id,
        sessionId: actor.sid, authVersion: actor.authVersion, operationDigest: `RECOVERY:${recoveryId}:${recovery.revision}`,
        usedAt: null, verifiedAt: { not: null }, expiresAt: { gt: new Date() }, proofHash: secretDigest(proofSecret) },
        data: { usedAt: new Date() } });
      if (consumed.count !== 1) throw new BadRequestException('Recovery email approval expired or was already used. Request a new code.');
      await tx.securityFactor.deleteMany({ where: { userId: actor.id, verifiedAt: null } });
      const expiresAt = new Date(Math.min(Date.now() + 600_000, recovery.approvedUntil!.getTime(), recovery.expiresAt.getTime()));
      await tx.securityFactor.create({ data: { id: factorId, userId: actor.id, kind: 'TOTP', label: 'Authenticator app',
        createdBySessionId: actor.sid, recoveryRequestId: recoveryId, secretCiphertext: ciphertext, expiresAt } });
      return { factorId, secret, uri: this.totp(secret, user.username).toString(),
        expiresInSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) };
    });
  }
  private async liveChallenge(
    tx: Prisma.TransactionClient,
    actor: SecurityActor,
    id: string,
  ) {
    const challenge = await tx.securityStepUpChallenge.findFirst({
      where: {
        id,
        userId: actor.id,
        sessionId: actor.sid,
        authVersion: actor.authVersion,
        usedAt: null,
        verifiedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: 5 },
      },
    });
    if (!challenge)
      throw new BadRequestException(
        'Verification expired or was already used. Retry the original action.',
      );
    return challenge;
  }
  async preparePasskey(actor: SecurityActor, id: string) {
    const { rpID } = this.passkeyConfig();
    const challenge = await this.prisma.securityStepUpChallenge.findFirst({
      where: {
        id,
        userId: actor.id,
        sessionId: actor.sid,
        authVersion: actor.authVersion,
        usedAt: null,
        verifiedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: 5 },
      },
    });
    if (
      !challenge ||
      challenge.operationDigest.startsWith('ENROLL:') ||
      challenge.operationDigest.startsWith('RECOVERY:') ||
      challenge.operationDigest === 'BOOTSTRAP'
    )
      throw new BadRequestException(
        'Verification expired. Retry the original action.',
      );
    const factors = await this.prisma.securityFactor.findMany({
      where: {
        userId: actor.id,
        kind: 'PASSKEY',
        revokedAt: null,
        verifiedAt: { not: null },
      },
      select: { credentialId: true, transports: true },
      take: 10,
    });
    if (!factors.length)
      throw new BadRequestException(
        'No passkey is enrolled. Use your authenticator app or a recovery code.',
      );
    return generateAuthenticationOptions({
      rpID,
      challenge: Uint8Array.from(Buffer.from(challenge.nonce, 'base64url')),
      userVerification: 'required',
      timeout: 60_000,
      allowCredentials: factors.map((factor) => ({
        id: factor.credentialId!,
        transports: factor.transports as any,
      })),
    });
  }
  async verify(
    actor: SecurityActor,
    id: string,
    proof: {
      code?: string;
      recoveryCode?: string;
      passkey?: AuthenticationResponseJSON;
    },
  ) {
    if (
      [proof.code, proof.recoveryCode, proof.passkey].filter(
        (value) => value !== undefined,
      ).length !== 1
    )
      throw new BadRequestException('Choose one verification method.');
    const result = await this.prisma.$transaction(async (tx) => {
      await lockCurrentSecurityActor(tx, actor);
      const challenge = await this.liveChallenge(tx, actor, id);
      if (
        challenge.operationDigest.startsWith('ENROLL:') ||
        challenge.operationDigest.startsWith('RECOVERY:') ||
        challenge.operationDigest === 'BOOTSTRAP'
      )
        throw new BadRequestException(
          'Use the enrollment confirmation screen.',
        );
      await tx.securityStepUpChallenge.update({
        where: { id },
        data: { attempts: { increment: 1 } },
      });
      let verified = false;
      if (proof.code) {
        const factor = await tx.securityFactor.findFirst({
          where: {
            userId: actor.id,
            kind: 'TOTP',
            revokedAt: null,
            verifiedAt: { not: null },
          },
        });
        if (factor?.secretCiphertext) {
          const step = this.acceptedTotpStep(
            factor.secretCiphertext,
            factor.id,
            actor,
            proof.code,
            factor.lastUsedStep,
          );
          if (step !== null) {
            await tx.securityFactor.update({
              where: { id: factor.id },
              data: { lastUsedStep: step },
            });
            verified = true;
          }
        }
      } else if (proof.recoveryCode) {
        const normalized = proof.recoveryCode
          .replaceAll('-', '')
          .trim()
          .toUpperCase();
        if (/^[A-F0-9]{32}$/.test(normalized)) {
          const consumed = await tx.securityRecoveryCode.updateMany({
            where: {
              userId: actor.id,
              usedAt: null,
              codeHash: secretDigest(`wiez:recovery:${actor.id}:${normalized}`),
            },
            data: { usedAt: new Date() },
          });
          verified = consumed.count === 1;
        }
      } else if (proof.passkey) {
        if (!boundedPasskeyResponse(proof.passkey, 'authentication')) return null;
        const { rpID, origins } = this.passkeyConfig();
        const factor = await tx.securityFactor.findFirst({
          where: {
            userId: actor.id,
            kind: 'PASSKEY',
            credentialId: proof.passkey.id,
            revokedAt: null,
            verifiedAt: { not: null },
          },
        });
        if (factor?.publicKey && Number.isSafeInteger(Number(factor.counter))) {
          try {
            const verification = await verifyAuthenticationResponse({
              response: proof.passkey,
              expectedChallenge: challenge.nonce,
              expectedOrigin: origins,
              expectedRPID: rpID,
              requireUserVerification: true,
              credential: {
                id: factor.credentialId!,
                publicKey: new Uint8Array(factor.publicKey),
                counter: Number(factor.counter),
                transports: factor.transports as any,
              },
            });
            verified = verification.verified;
            if (verified)
              await tx.securityFactor.update({
                where: { id: factor.id },
                data: {
                  counter: BigInt(verification.authenticationInfo.newCounter),
                },
              });
          } catch {
            verified = false;
          }
        }
      }
      if (!verified) return null; // Commit failed-attempt count; throwing here would roll it back.
      await this.markStrong(tx, actor);
      const secret = randomSecuritySecret();
      await tx.securityStepUpChallenge.update({
        where: { id },
        data: {
          verifiedAt: new Date(),
          proofHash:
            challenge.sensitivity === 'CRITICAL_CHANGE'
              ? secretDigest(secret)
              : null,
          usedAt:
            challenge.sensitivity === 'SENSITIVE_READ' ? new Date() : null,
        },
      });
      return {
        verified: true,
        actionProof:
          challenge.sensitivity === 'CRITICAL_CHANGE'
            ? `${id}.${secret}`
            : null,
        readVerificationSeconds: STRONG_READ_WINDOW_MS / 1000,
      };
    });
    if (!result)
      throw new BadRequestException(
        'Verification failed. Use a new authenticator code, your passkey, or an unused recovery code.',
      );
    return result;
  }
  async beginPasskey(
    actor: SecurityActor,
    password: string,
    label: string,
    enrollmentProof?: string,
  ) {
    const { rpID } = this.passkeyConfig();
    if (typeof label !== 'string' || !label.trim() || [...label.trim()].length > 80)
      throw new BadRequestException('Enter a passkey name of 1–80 characters.');
    const passwordHash = await this.primaryProof(actor, password);
    const factorId = randomUUID();
    const nonce = randomSecuritySecret();
    const { user, challengeId, existing } = await withSecurityTransaction(
      this.prisma,
      async (tx) => {
        const { user } = await this.checkEnrollment(
          tx,
          actor,
          passwordHash,
          'passkeys',
          enrollmentProof,
        );
        const pending = await tx.securityFactor.count({
          where: {
            userId: actor.id,
            verifiedAt: null,
            expiresAt: { gt: new Date() },
          },
        });
        if (pending >= 3)
          throw new BadRequestException(
            'Finish or wait for the existing authentication setup before starting another.',
          );
        await tx.securityFactor.create({
          data: {
            id: factorId,
            userId: actor.id,
            kind: 'PASSKEY',
            label: label.trim() || 'Passkey',
            createdBySessionId: actor.sid,
            expiresAt: new Date(Date.now() + 600_000),
          },
        });
        const challenge = await tx.securityStepUpChallenge.create({
          data: {
            id: randomUUID(),
            userId: actor.id,
            sessionId: actor.sid,
            authVersion: actor.authVersion,
            operationDigest: `ENROLL:${factorId}`,
            method: 'POST',
            route: 'passkey-enrollment',
            sensitivity: 'CRITICAL_CHANGE',
            nonce,
            expiresAt: new Date(Date.now() + 300_000),
          },
        });
        const existing = await tx.securityFactor.findMany({
          where: {
            userId: actor.id,
            kind: 'PASSKEY',
            revokedAt: null,
            verifiedAt: { not: null },
          },
          select: { credentialId: true, transports: true },
          take: 10,
        });
        return { user, challengeId: challenge.id, existing };
      },
    );
    return {
      challengeId,
      expiresInSeconds: 300,
      options: await generateRegistrationOptions({
        rpName: 'WIEZ',
        rpID,
        userName: user.username,
        userDisplayName: user.username,
        userID: new TextEncoder().encode(actor.id),
        challenge: Uint8Array.from(Buffer.from(nonce, 'base64url')),
        attestationType: 'none',
        authenticatorSelection: {
          residentKey: 'required',
          userVerification: 'required',
        },
        excludeCredentials: existing.map((factor) => ({
          id: factor.credentialId!,
          transports: factor.transports as any,
        })),
      }),
    };
  }
  async confirmPasskey(
    actor: SecurityActor,
    challengeId: string,
    response: RegistrationResponseJSON,
  ) {
    const { rpID, origins } = this.passkeyConfig();
    const confirmed = await this.prisma.$transaction(async (tx) => {
      await lockCurrentSecurityActor(tx, actor);
      const challenge = await this.liveChallenge(tx, actor, challengeId);
      if (!challenge.operationDigest.startsWith('ENROLL:'))
        throw new BadRequestException('Invalid passkey enrollment.');
      const factorId = challenge.operationDigest.slice('ENROLL:'.length);
      const factor = await tx.securityFactor.findFirst({
        where: {
          id: factorId,
          userId: actor.id,
          kind: 'PASSKEY',
          revokedAt: null,
          verifiedAt: null,
          createdBySessionId: actor.sid,
          expiresAt: { gt: new Date() },
        },
      });
      if (!factor)
        throw new BadRequestException('Passkey setup expired. Start again.');
      await tx.securityStepUpChallenge.update({
        where: { id: challengeId }, data: { attempts: { increment: 1 } },
      });
      if (!boundedPasskeyResponse(response, 'registration')) return null;
      let result;
      try {
        result = await verifyRegistrationResponse({
          response,
          expectedChallenge: challenge.nonce,
          expectedOrigin: origins,
          expectedRPID: rpID,
          requireUserVerification: true,
        });
      } catch {
        return null;
      }
      if (!result.verified || !result.registrationInfo) return null;
      const { credential } = result.registrationInfo;
      // A credential is bound to one account, including after revocation. Do not reveal its owner.
      if (await tx.securityFactor.findUnique({ where: { credentialId: credential.id }, select: { id: true } }))
        throw new ConflictException('This passkey is already registered. Reload your methods or create a different passkey.');
      const confirmed = await this.finishFactorConfirmation(tx, actor, factor, {
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey),
        counter: BigInt(credential.counter),
        transports: credential.transports ?? [],
      });
      await tx.securityStepUpChallenge.update({
        where: { id: challengeId },
        data: { verifiedAt: new Date(), usedAt: new Date() },
      });
      return confirmed;
    }).catch((error: unknown) => {
      if ((error as { code?: string })?.code === 'P2002')
        throw new ConflictException('This passkey is already registered. Reload your methods or create a different passkey.');
      throw error;
    });
    if (!confirmed) throw new BadRequestException('Passkey verification failed. Try again; after five failed attempts, restart setup.');
    return confirmed;
  }

  async revokeFactor(actor: SecurityActor, factorId: string, password: string) {
    requireMfaManagementAction(actor, 'remove', factorId);
    const passwordHash = await this.primaryProof(actor, password);
    await withSecurityTransaction(this.prisma, async (tx) => {
      const { user } = await lockCurrentSecurityActor(tx, actor);
      if (user.password !== passwordHash)
        throw new UnauthorizedException(
          'Account security changed. Sign in again.',
        );
      const factor = await tx.securityFactor.findFirst({
        where: {
          id: factorId,
          userId: actor.id,
          revokedAt: null,
          verifiedAt: { not: null },
        },
      });
      if (!factor)
        throw new NotFoundException(
          'This sign-in method is no longer available.',
        );
      if (
        (await tx.securityFactor.count({
          where: {
            userId: actor.id,
            revokedAt: null,
            verifiedAt: { not: null },
          },
        })) <= 1
      )
        throw new ConflictException(
          'Verify a replacement before removing your last sign-in method.',
        );
      const now = new Date();
      await tx.securityFactor.update({
        where: { id: factorId },
        data: { revokedAt: now, secretCiphertext: null },
      });
      await this.invalidateStrongAuthority(tx, actor);
      await this.notifyFactorChange(
        tx,
        actor,
        `${factorId}:revoked`,
        'A verified sign-in method was removed from your WIEZ account.',
      );
    });
    return { success: true };
  }

  async regenerateRecoveryCodes(actor: SecurityActor, password: string) {
    const operation = requireMfaManagementAction(actor, 'recovery-codes');
    const passwordHash = await this.primaryProof(actor, password);
    return withSecurityTransaction(this.prisma, async (tx) => {
      const { user } = await lockCurrentSecurityActor(tx, actor);
      if (user.password !== passwordHash)
        throw new UnauthorizedException(
          'Account security changed. Sign in again.',
        );
      const factor = await tx.securityFactor.findFirst({
        where: { userId: actor.id, revokedAt: null, verifiedAt: { not: null } },
        select: { id: true },
      });
      if (!factor)
        throw new ConflictException(
          'Enable and verify a sign-in method before replacing recovery codes.',
        );
      const codes = await this.recoveryCodes(tx, actor.id, factor.id);
      await this.invalidateStrongAuthority(tx, actor);
      await this.markStrong(tx, actor);
      await this.notifyFactorChange(
        tx,
        actor,
        operation.requestId,
        'Your WIEZ recovery codes were replaced. Previous recovery codes no longer work.',
      );
      return { recoveryCodes: codes };
    });
  }

  @Cron(CronExpression.EVERY_HOUR)
  async pruneAbandonedSetups() {
    await this.prisma.$executeRaw`
      DELETE FROM "SecurityFactor" WHERE id IN (
        SELECT id FROM "SecurityFactor" WHERE "verifiedAt" IS NULL AND "expiresAt" <= clock_timestamp()
        ORDER BY "expiresAt",id LIMIT 1000 FOR UPDATE SKIP LOCKED
      ) AND "verifiedAt" IS NULL`;
    await this.prisma.$executeRaw`
      DELETE FROM "SecurityStepUpChallenge" WHERE id IN (
        SELECT id FROM "SecurityStepUpChallenge" WHERE "usedAt" IS NULL AND "expiresAt" <= clock_timestamp()
          AND route IN ('mfa-enrollment','passkey-enrollment','mfa-reviewed-recovery')
        ORDER BY "expiresAt",id LIMIT 1000 FOR UPDATE SKIP LOCKED
      ) AND "usedAt" IS NULL`;
  }
}
