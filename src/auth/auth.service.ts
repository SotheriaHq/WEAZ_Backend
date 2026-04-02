import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-auth.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { PasswordService } from 'src/auth/helper/password.service';
import { LoginDto } from './dto/login-auth.dto';
import { v4 as uuidv4 } from 'uuid';
import {
  UserType,
  Role,
  NotificationType,
  UserStatus,
  Prisma,
  EmailPriority,
} from '@prisma/client';
import {
  authUserSelect,
  profileUserSelect,
  toAuthUserResponse,
  AuthUser,
} from 'src/auth/helper/prisma-select.helper';
import { TokenService } from './helper/general.helper';
import { Request, Response } from 'express';
import { UserHelperService } from './helper/user-helper.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { NotificationsService } from 'src/notifications/notifications.service';
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';
import { EmailService, type EnqueueEmailResult } from 'src/email/email.service';
import * as emailTemplates from 'src/email/email.templates';
import { createHash, randomBytes } from 'crypto';
import { TrustedDeviceService } from './helper/trusted-device.service';
import {
  PasswordPolicyContext,
  validatePasswordPolicy,
} from './helper/password-policy.helper';

const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const RESET_REQUEST_SUPPRESSION_MS = 2 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly userHelperService: UserHelperService,
    private readonly emailVerificationHelper: EmailVerificationHelperService,
    private readonly notifications: NotificationsService,
    private readonly emailService: EmailService,
    private readonly trustedDeviceService: TrustedDeviceService,
  ) { }

  private buildPasswordPolicyContext(
    context: PasswordPolicyContext,
  ): PasswordPolicyContext {
    return {
      email: context.email ?? null,
      username: context.username ?? null,
      brandFullName: context.brandFullName ?? null,
      firstName: context.firstName ?? null,
      lastName: context.lastName ?? null,
    };
  }

  private logEmailDispatchOutcome(args: {
    scenarioKey: string;
    userId: string;
    recipientEmail: string;
    result: EnqueueEmailResult;
  }): void {
    const summary =
      `scenario=${args.scenarioKey} userId=${args.userId} ` +
      `recipient=${args.recipientEmail} outboxId=${args.result.outboxId ?? 'n/a'} ` +
      `dispatchStatus=${args.result.dispatchStatus}`;

    if (args.result.dispatchStatus === 'FAILED') {
      this.logger.error(
        `Auth email dispatch failed: ${summary} error=${args.result.errorMessage ?? 'unknown'}`,
      );
      return;
    }

    if (args.result.dispatchStatus === 'SUPPRESSED') {
      this.logger.warn(
        `Auth email dispatch suppressed: ${summary} reason=${args.result.errorMessage ?? 'n/a'}`,
      );
      return;
    }

    this.logger.log(
      `Auth email dispatch outcome: ${summary} providerMessageId=${args.result.providerMessageId ?? 'n/a'}`,
    );
  }

  private extractClientIp(req: Request): string | null {
    return req.ip || req.socket?.remoteAddress || null;
  }

  private validateBrandRequirements(signupDto: CreateUserDto): void {
    const missingFields: string[] = [];
    if (!signupDto.firstName?.trim()) missingFields.push('firstName');
    if (!signupDto.lastName?.trim()) missingFields.push('lastName');
    if (!signupDto.brandFullName?.trim()) missingFields.push('brandFullName');

    if (missingFields.length > 0) {
      throw new BadRequestException(
        `Missing required fields for BRAND users: ${missingFields.join(', ')}`,
      );
    }
  }
  async CreateUser(signupDto: CreateUserDto, req: Request, res: Response) {
    // Normalize email: trim whitespace and convert to lowercase for case-insensitive matching
    const normalizedEmail = signupDto.email?.trim().toLowerCase();
    signupDto.email = normalizedEmail;

    try {
      const existingUser = await this.prisma.user
        .findUnique({
          where: { email: normalizedEmail },
        })
        .catch((dbError) => {
          this.logger.error('Database error checking existing user:', dbError);
          throw new BadRequestException('Database connection error');
        });

      if (existingUser) {
        throw new BadRequestException('Email Already Exist');
      }

      signupDto.firstName = signupDto.firstName?.trim();
      signupDto.lastName = signupDto.lastName?.trim();
      if (signupDto.brandFullName) {
        signupDto.brandFullName = signupDto.brandFullName.trim();
      }
      // Validate BRAND requirements
      if (signupDto.type === UserType.BRAND) {
        this.validateBrandRequirements(signupDto);
      }

      // Regular users must provide firstName and lastName
      if (signupDto.type !== UserType.BRAND) {
        const missingNames: string[] = [];
        if (!signupDto.firstName) missingNames.push('firstName');
        if (!signupDto.lastName) missingNames.push('lastName');
        if (missingNames.length > 0) {
          throw new BadRequestException(
            `Missing required fields for REGULAR users: ${missingNames.join(', ')}`,
          );
        }
      }

      let username: string;
      try {
        if (signupDto.type === UserType.BRAND && signupDto.brandFullName) {
          username = await this.userHelperService.generateUsernameFromBrand(
            signupDto.brandFullName,
          );
        } else {
          username = await this.userHelperService.generateUniqueUsername(
            signupDto.firstName,
            signupDto.lastName,
          );
        }
      } catch (usernameError) {
        this.logger.error('Username generation failed:', usernameError);
        throw new BadRequestException('Failed to generate username');
      }

      validatePasswordPolicy(
        signupDto.password,
        this.buildPasswordPolicyContext({
          email: signupDto.email,
          username,
          brandFullName: signupDto.brandFullName,
          firstName: signupDto.firstName,
          lastName: signupDto.lastName,
        }),
      );

      let industriNumber: string | null = null;
      if (signupDto.type === UserType.BRAND) {
        try {
          industriNumber =
            await this.userHelperService.generateIndustriNumber();
        } catch (industriError) {
          this.logger.error(
            'Industri number generation failed:',
            industriError,
          );
          throw new BadRequestException('Failed to generate industri number');
        }
      }

      let hashedPassword: string;
      try {
        hashedPassword = await this.passwordService.hashPassword(
          signupDto.password,
        );
      } catch (hashError) {
        this.logger.error('Password hashing failed:', hashError);
        throw new BadRequestException('Password processing failed');
      }

      // Generate email verification code
      const verificationCode =
        this.emailVerificationHelper.generateVerificationCode();
      // Ensure database-required name fields are present. Prisma User model requires firstName and lastName.
      const dbFirstName = signupDto.firstName ?? '';
      const dbLastName = signupDto.lastName ?? '';

      const user = await this.prisma.user
        .create({
          data: {
            id: uuidv4(),
            username,
            // Never trust role from client-controlled signup payload.
            role: Role.User,
            firstName: dbFirstName,
            lastName: dbLastName,
            email: signupDto.email,
            password: hashedPassword,
            brandFullName: signupDto.brandFullName,
            type: signupDto.type ?? UserType.REGULAR,
            industriNumber,
            emailVerificationCode: verificationCode,
            isEmailVerified: false,
            ...(signupDto.type === UserType.BRAND
              ? {
                brand: {
                  create: {
                    id: uuidv4(),
                    name: signupDto.brandFullName!,
                    storeNameLastChangedAt: new Date(),
                    currency: 'NGN',
                  },
                },
              }
              : {}),
          },
          select: authUserSelect,
        })
        .catch((dbError) => {
          this.logger.error('Database error creating user:', dbError);

          if (dbError.code === 'P2002') {
            throw new BadRequestException('Email or CAC number already exists');
          }
          throw new BadRequestException('Failed to create user account');
        });

// Send verification email
    const verificationLink = this.emailVerificationHelper.generateVerificationLink(
      user.id,
      verificationCode,
    );
    const verificationEmail = emailTemplates.emailVerificationEmail(
      verificationCode,
      verificationLink,
      this.emailService.getAppName(),
    );
    const verificationDispatchResult = await this.emailService.send(
      user.email,
      verificationEmail.subject,
      verificationEmail.html,
      verificationEmail.text,
      {
        recipientUserId: user.id,
        scenarioKey: 'auth.email_verification',
        priority: EmailPriority.P1_TRANSACTIONAL,
        idempotencyKey: `auth:email-verification:${user.id}:${verificationCode}`,
        dispatchImmediately: true,
      },
    );
    this.logEmailDispatchOutcome({
      scenarioKey: 'auth.email_verification',
      userId: user.id,
      recipientEmail: user.email,
      result: verificationDispatchResult,
    });

      let accessToken: string;
      let refreshToken: string | undefined;
      try {
        const tokenResult = await this.tokenService.generateTokens(
          user,
          req,
          res,
        );
        accessToken = tokenResult.accessToken;
        refreshToken = tokenResult.refreshToken;
      } catch (tokenError) {
        this.logger.error('Token generation failed:', tokenError);
        // If token generation fails, we should probably inform the user or fail the request
        // returning success with null token is confusing.
        throw new BadRequestException(
          'Account created but failed to generate login session. Please log in manually.',
        );
      }

      // Notify SIGNUP event (account created) without blocking signup latency.
      void this.notifications
        .create(user.id, NotificationType.SIGNUP, {
          payload: { action: 'SIGNUP', email: user.email },
        })
        .catch(() => undefined);

      return {
        user: toAuthUserResponse(user),
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        message: 'Welcome TO THE INDUSTRY!',
      };
    } catch (error) {
      this.logger.error('Signup error:', error.message, error.stack);
      if (error.code === 'P2002') {
        throw new BadRequestException('Email or CAC number already exists');
      }
      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException(`Failed to create user: ${error.message}`);
    }
  }

  async login(dto: LoginDto, req: Request, res: Response) {
    try {
      const user = await this.validateUser(dto.email, dto.password);
      if (!user) {
        throw new UnauthorizedException('Invalid email or password');
      }

      let accessToken: string;
      let refreshToken: string | undefined;
      try {
        const tokenResult = await this.tokenService.generateTokens(
          user,
          req,
          res,
        );
        accessToken = tokenResult.accessToken;
        refreshToken = tokenResult.refreshToken;
      } catch (tokenError) {
        this.logger.error('Token generation failed during login:', tokenError);
        throw new UnauthorizedException(
          'Login failed - token generation error',
        );
      }

      // Notify LOGIN event (login activity) without blocking login latency.
      const ipAddress = this.extractClientIp(req);
      const deviceResult = await this.trustedDeviceService.recordLoginDevice(
        user.id,
        req,
      );

      void this.notifications
        .create(user.id, NotificationType.LOGIN, {
          payload: {
            ip: ipAddress,
            userAgent: req.headers['user-agent'] ?? null,
            newDevice: deviceResult.isNewDevice,
          },
        })
        .catch(() => undefined);

      return {
        user: toAuthUserResponse(user),
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        message: 'Welcome Back',
      };
    } catch (error) {
      this.logger.error('Login error:', error.message, error.stack);

      if (error instanceof UnauthorizedException) {
        throw error;
      }
      throw new UnauthorizedException(`Login failed: ${error.message}`);
    }
  }

  async getTrustedDevices(userId: string) {
    return this.trustedDeviceService.listDevices(userId);
  }

  async revokeTrustedDevice(userId: string, deviceId: string) {
    return this.trustedDeviceService.revokeDevice(userId, deviceId);
  }

  // Validates user credentials for login
  async validateUser(email: string, password: string) {
    // Normalize email: trim whitespace and convert to lowercase for case-insensitive matching
    const normalizedEmail = email?.trim().toLowerCase();

    try {
      const user = await this.prisma.user
        .findFirst({
          where: {
            email: normalizedEmail,
          },
          select: {
            ...authUserSelect,
            password: true,
          },
        })
        .catch((dbError) => {
          this.logger.error('Database error during user validation:', dbError);
          return null;
        });

      if (!user) {
        return null;
      }

      const { password: hashedPassword, ...publicUser } = user;

      const isPasswordValid = await this.passwordService
        .verifyPassword(hashedPassword, password)
        .catch((verifyError) => {
          this.logger.error('Password verification failed:', verifyError);
          return false;
        });

      if (!isPasswordValid) {
        return null;
      }

      if (user.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedException(
          'User account is suspended or deactivated. Submit a reactivation request.',
        );
      }

      if (
        user.mustResetPassword &&
        (user.role === Role.Admin || user.role === Role.SuperAdmin)
      ) {
        throw new UnauthorizedException(
          'Password reset required for this admin account before login',
        );
      }

      return publicUser as AuthUser;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      this.logger.error('User validation error:', error);
      return null;
    }
  }

  async getProfile(userId: string) {
    try {
      const user = await this.prisma.user
        .findUnique({
          where: { id: userId },
          select: authUserSelect,
        })
        .catch((dbError) => {
          this.logger.error('Database error fetching profile:', dbError);
          throw new UnauthorizedException('Profile fetch failed');
        });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      return toAuthUserResponse(user);
    } catch (error) {
      this.logger.error('Get profile error:', error);

      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException(
        `Profile fetch failed: ${error.message || 'Unknown error'}`,
      );
    }
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto & { profileImageId?: string },
  ) {
    // Prevent password update
    if ((dto as any).password !== undefined) {
      throw new BadRequestException('Password cannot be updated here');
    }
    try {
      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: dto,
        select: profileUserSelect,
      });
      return toAuthUserResponse(updatedUser);
    } catch (error) {
      this.logger.error('Profile update error:', error);
      throw new BadRequestException('Failed to update profile');
    }
  }

  // Verify email by link
  async verifyEmailByLink(userId: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');
    if (user.isEmailVerified) return { message: 'Email already verified' };
    if (user.emailVerificationCode !== code)
      throw new BadRequestException('Invalid verification code');
    await this.prisma.user.update({
      where: { id: userId },
      data: { isEmailVerified: true, emailVerificationCode: null },
    });
    try {
      await this.notifications.create(userId, NotificationType.SIGNUP, {
        payload: { action: 'EMAIL_VERIFIED' },
      });
    } catch { }
    return { message: 'Email verified successfully' };
  }

  // Verify email by code
  async verifyEmailByCode(email: string, code: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new BadRequestException('User not found');
    if (user.isEmailVerified) return { message: 'Email already verified' };
    if (user.emailVerificationCode !== code)
      throw new BadRequestException('Invalid verification code');
    await this.prisma.user.update({
      where: { email },
      data: { isEmailVerified: true, emailVerificationCode: null },
    });
    try {
      await this.notifications.create(user.id, NotificationType.SIGNUP, {
        payload: { action: 'EMAIL_VERIFIED' },
      });
    } catch { }
    return { message: 'Email verified successfully' };
  }

  async getProfileWithImage(userId: string) {
    try {
      const user = await this.prisma.user
        .findUnique({
          where: { id: userId },
          select: profileUserSelect,
        })
        .catch((dbError) => {
          this.logger.error('Database error fetching profile:', dbError);
          throw new UnauthorizedException('Profile fetch failed');
        });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      return toAuthUserResponse(user);
    } catch (error) {
      this.logger.error('Get profile error:', error);

      if (error instanceof UnauthorizedException) {
        throw error;
      }

      throw new UnauthorizedException(
        `Profile fetch failed: ${error.message || 'Unknown error'}`,
      );
    }
  }

  async requestAccountReactivation(email: string, reason: string) {
    const genericResponse = {
      message:
        'If this account is suspended or deactivated, your reactivation request has been submitted.',
    };

    const normalizedEmail = email?.trim().toLowerCase();
    const normalizedReason = reason?.trim();
    if (!normalizedEmail || !normalizedReason) {
      throw new BadRequestException('Email and reason are required');
    }
    if (normalizedReason.length < 15) {
      throw new BadRequestException(
        'Reason must be at least 15 characters long',
      );
    }
    if (normalizedReason.length > 1200) {
      throw new BadRequestException(
        'Reason must be at most 1200 characters long',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, status: true, email: true },
    });

    // Generic response to avoid account status/email enumeration
    if (!user || user.status === UserStatus.ACTIVE) {
      return genericResponse;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const existingPending =
              await tx.accountReactivationRequest.findFirst({
                where: { userId: user.id, status: 'PENDING' },
                select: { id: true },
              });

            if (existingPending) {
              return {
                message:
                  'A reactivation request is already pending review. We will contact you after review.',
              };
            }

            await tx.accountReactivationRequest.create({
              data: {
                id: uuidv4(),
                userId: user.id,
                emailSnapshot: user.email,
                reason: normalizedReason,
              },
            });

            return {
              message:
                'Your reactivation request has been submitted. Admin review is pending.',
            };
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );
      } catch (error: any) {
        if (error?.code === 'P2034' && attempt < 2) {
          continue;
        }
        throw error;
      }
    }

    throw new BadRequestException(
      'Could not submit reactivation request at this time. Please retry.',
    );
  }

  async requestAdminPasswordReset(email: string) {
    const genericResponse = {
      message: 'If the account exists, a reset link has been generated.',
    };

    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException('Email is required');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, role: true },
    });

    if (!user || (user.role !== Role.Admin && user.role !== Role.SuperAdmin)) {
      return genericResponse;
    }

    let rawTokenToSend: string | null = null;
    let tokenHashToSend: string | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = new Date();
      const suppressionCutoff = new Date(
        now.getTime() - RESET_REQUEST_SUPPRESSION_MS,
      );
      const candidateRawToken = randomBytes(32).toString('hex');
      const candidateTokenHash = createHash('sha256')
        .update(candidateRawToken)
        .digest('hex');
      const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

      try {
        const shouldCreateToken = await this.prisma.$transaction(
          async (tx) => {
            const latestActiveToken = await tx.passwordResetToken.findFirst({
              where: {
                userId: user.id,
                usedAt: null,
                expiresAt: { gt: now },
              },
              orderBy: { createdAt: 'desc' },
              select: { createdAt: true },
            });

            if (
              latestActiveToken &&
              latestActiveToken.createdAt > suppressionCutoff
            ) {
              return false;
            }

            await tx.passwordResetToken.updateMany({
              where: {
                userId: user.id,
                usedAt: null,
                expiresAt: { gt: now },
              },
              data: { usedAt: now },
            });

            await tx.passwordResetToken.create({
              data: {
                id: uuidv4(),
                userId: user.id,
                tokenHash: candidateTokenHash,
                expiresAt,
              },
            });

            return true;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );

        if (shouldCreateToken) {
          rawTokenToSend = candidateRawToken;
          tokenHashToSend = candidateTokenHash;
        }
        break;
      } catch (error: any) {
        if (error?.code === 'P2034' && attempt < 2) {
          continue;
        }
        throw error;
      }
    }

    if (!rawTokenToSend) {
      this.logger.log(
        `Admin password reset suppressed for user ${user.id} due to recent active token`,
      );
      return genericResponse;
    }

    // Send reset email
    const baseUrl = (process.env.WEB_APP_URL || 'http://localhost:5173').replace(/\/$/, '');
    const resetLink = `${baseUrl}/admin/reset-password?token=${rawTokenToSend}`;
    const resetEmail = emailTemplates.passwordResetEmail(
      resetLink,
      this.emailService.getAppName(),
    );
    const adminResetDispatchResult = await this.emailService.send(
      normalizedEmail,
      resetEmail.subject,
      resetEmail.html,
      resetEmail.text,
      {
        recipientUserId: user.id,
        scenarioKey: 'auth.admin_password_reset',
        priority: EmailPriority.P0_SECURITY,
        idempotencyKey: tokenHashToSend
          ? `auth:admin-password-reset:${user.id}:${tokenHashToSend}`
          : undefined,
        dispatchImmediately: true,
      },
    );
    this.logEmailDispatchOutcome({
      scenarioKey: 'auth.admin_password_reset',
      userId: user.id,
      recipientEmail: normalizedEmail,
      result: adminResetDispatchResult,
    });

    return genericResponse;
  }

  async resetAdminPassword(token: string, newPassword: string) {
    if (!token || !newPassword) {
      throw new BadRequestException('Token and new password are required');
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');

    const resetToken = await this.prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
          select: {
            id: true,
            role: true,
            status: true,
            password: true,
            email: true,
            username: true,
            brandFullName: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    if (
      !resetToken ||
      (resetToken.user.role !== Role.Admin &&
        resetToken.user.role !== Role.SuperAdmin)
    ) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    if (resetToken.user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('This account is not active');
    }

    validatePasswordPolicy(
      newPassword,
      this.buildPasswordPolicyContext({
        email: resetToken.user.email,
        username: resetToken.user.username,
        brandFullName: resetToken.user.brandFullName,
        firstName: resetToken.user.firstName,
        lastName: resetToken.user.lastName,
      }),
    );

    const isSamePassword = await this.passwordService.verifyPassword(
      resetToken.user.password,
      newPassword,
    );
    if (isSamePassword) {
      throw new BadRequestException(
        'New password must be different from your current password',
      );
    }

    const password = await this.passwordService.hashPassword(newPassword);
    const now = new Date();

    await this.prisma.$transaction(
      async (tx) => {
        const claimedToken = await tx.passwordResetToken.updateMany({
          where: {
            id: resetToken.id,
            usedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        });

        if (claimedToken.count !== 1) {
          throw new UnauthorizedException('Invalid or expired reset token');
        }

        await tx.refreshToken.deleteMany({ where: { userId: resetToken.userId } });

        await tx.user.update({
          where: { id: resetToken.userId },
          data: {
            password,
            mustResetPassword: false,
            authVersion: { increment: 1 },
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    return { message: 'Password reset successful' };
  }

  async requestPasswordReset(email: string) {
    const genericResponse = {
      message:
        'If an account with that email exists, a password reset link has been sent.',
    };

    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException('Email is required');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, status: true },
    });

    // Always return generic response to prevent email enumeration
    if (!user || user.status !== UserStatus.ACTIVE) {
      this.logger.log(
        `Password reset requested for unknown or inactive email: ${normalizedEmail}`,
      );
      return genericResponse;
    }

    let rawTokenToSend: string | null = null;
    let tokenHashToSend: string | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = new Date();
      const suppressionCutoff = new Date(
        now.getTime() - RESET_REQUEST_SUPPRESSION_MS,
      );
      const candidateRawToken = randomBytes(32).toString('hex');
      const candidateTokenHash = createHash('sha256')
        .update(candidateRawToken)
        .digest('hex');
      const expiresAt = new Date(now.getTime() + PASSWORD_RESET_TOKEN_TTL_MS);

      try {
        const shouldCreateToken = await this.prisma.$transaction(
          async (tx) => {
            const latestActiveToken = await tx.passwordResetToken.findFirst({
              where: {
                userId: user.id,
                usedAt: null,
                expiresAt: { gt: now },
              },
              orderBy: { createdAt: 'desc' },
              select: { createdAt: true },
            });

            if (
              latestActiveToken &&
              latestActiveToken.createdAt > suppressionCutoff
            ) {
              return false;
            }

            await tx.passwordResetToken.updateMany({
              where: {
                userId: user.id,
                usedAt: null,
                expiresAt: { gt: now },
              },
              data: { usedAt: now },
            });

            await tx.passwordResetToken.create({
              data: {
                id: uuidv4(),
                userId: user.id,
                tokenHash: candidateTokenHash,
                expiresAt,
              },
            });

            return true;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          },
        );

        if (shouldCreateToken) {
          rawTokenToSend = candidateRawToken;
          tokenHashToSend = candidateTokenHash;
        }
        break;
      } catch (error: any) {
        if (error?.code === 'P2034' && attempt < 2) {
          continue;
        }
        throw error;
      }
    }

    if (!rawTokenToSend) {
      this.logger.log(
        `Password reset suppressed for user ${user.id} due to recent active token`,
      );
      return genericResponse;
    }

    // Send reset email
    const baseUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    const resetLink = `${baseUrl}/reset-password?token=${rawTokenToSend}`;
    const resetEmail = emailTemplates.passwordResetEmail(
      resetLink,
      this.emailService.getAppName(),
    );
    const passwordResetDispatchResult = await this.emailService.send(
      normalizedEmail,
      resetEmail.subject,
      resetEmail.html,
      resetEmail.text,
      {
        recipientUserId: user.id,
        scenarioKey: 'auth.password_reset',
        priority: EmailPriority.P0_SECURITY,
        idempotencyKey: tokenHashToSend
          ? `auth:password-reset:${user.id}:${tokenHashToSend}`
          : undefined,
        dispatchImmediately: true,
      },
    );
    this.logEmailDispatchOutcome({
      scenarioKey: 'auth.password_reset',
      userId: user.id,
      recipientEmail: normalizedEmail,
      result: passwordResetDispatchResult,
    });

    this.logger.log(`Password reset requested for user ${user.id}`);

    return genericResponse;
  }

  async confirmPasswordReset(token: string, newPassword: string) {
    if (!token || !newPassword) {
      throw new BadRequestException('Token and new password are required');
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');

    const resetToken = await this.prisma.passwordResetToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: {
        user: {
          select: {
            id: true,
            status: true,
            password: true,
            email: true,
            username: true,
            brandFullName: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    if (!resetToken) {
      throw new UnauthorizedException('Invalid or expired reset token');
    }

    if (resetToken.user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('This account is not active');
    }

    validatePasswordPolicy(
      newPassword,
      this.buildPasswordPolicyContext({
        email: resetToken.user.email,
        username: resetToken.user.username,
        brandFullName: resetToken.user.brandFullName,
        firstName: resetToken.user.firstName,
        lastName: resetToken.user.lastName,
      }),
    );

    const isSamePassword = await this.passwordService.verifyPassword(
      resetToken.user.password,
      newPassword,
    );
    if (isSamePassword) {
      throw new BadRequestException(
        'New password must be different from your current password',
      );
    }

    const password = await this.passwordService.hashPassword(newPassword);
    const now = new Date();

    await this.prisma.$transaction(
      async (tx) => {
        const claimedToken = await tx.passwordResetToken.updateMany({
          where: {
            id: resetToken.id,
            usedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        });

        if (claimedToken.count !== 1) {
          throw new UnauthorizedException('Invalid or expired reset token');
        }

        await tx.refreshToken.deleteMany({ where: { userId: resetToken.userId } });

        await tx.user.update({
          where: { id: resetToken.userId },
          data: {
            password,
            authVersion: { increment: 1 },
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    this.logger.log(`Password reset confirmed for user ${resetToken.userId}`);

    return { message: 'Password reset successful' };
  }

  async changePasswordForAuthenticatedUser(
    userId: string,
    currentPassword: string | undefined,
    newPassword: string,
  ) {
    if (!newPassword) {
      throw new BadRequestException('New password is required');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        brandFullName: true,
        firstName: true,
        lastName: true,
        password: true,
        mustResetPassword: true,
      },
    });
    if (!user) throw new UnauthorizedException('User not found');

    // If not in forced-reset mode, verify current password.
    if (!user.mustResetPassword) {
      if (!currentPassword) {
        throw new BadRequestException('Current password is required');
      }

      const valid = await this.passwordService.verifyPassword(
        user.password,
        currentPassword,
      );
      if (!valid) {
        throw new UnauthorizedException('Current password is incorrect');
      }
    }

    validatePasswordPolicy(
      newPassword,
      this.buildPasswordPolicyContext({
        email: user.email,
        username: user.username,
        brandFullName: user.brandFullName,
        firstName: user.firstName,
        lastName: user.lastName,
      }),
    );

    const isSamePassword = await this.passwordService.verifyPassword(
      user.password,
      newPassword,
    );
    if (isSamePassword) {
      throw new BadRequestException(
        'New password must be different from your current password',
      );
    }

    const password = await this.passwordService.hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.deleteMany({ where: { userId } });

      await tx.user.update({
        where: { id: userId },
        data: {
          password,
          mustResetPassword: false,
          authVersion: { increment: 1 },
        },
      });
    });

    return { message: 'Password updated successfully' };
  }

  async completeAdminFirstLoginReset(
    email: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail || !currentPassword || !newPassword) {
      throw new BadRequestException('Email, current password, and new password are required');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException('New password must be different from temporary password');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        role: true,
        password: true,
        mustResetPassword: true,
        email: true,
        username: true,
        brandFullName: true,
        firstName: true,
        lastName: true,
      },
    });

    if (!user || (user.role !== Role.Admin && user.role !== Role.SuperAdmin)) {
      throw new UnauthorizedException('Invalid account or credentials');
    }
    if (!user.mustResetPassword) {
      throw new BadRequestException('This account does not require a password reset');
    }

    const valid = await this.passwordService.verifyPassword(
      user.password,
      currentPassword,
    );
    if (!valid) {
      throw new UnauthorizedException('Temporary password is incorrect');
    }

    validatePasswordPolicy(
      newPassword,
      this.buildPasswordPolicyContext({
        email: user.email,
        username: user.username,
        brandFullName: user.brandFullName,
        firstName: user.firstName,
        lastName: user.lastName,
      }),
    );

    const isSamePassword = await this.passwordService.verifyPassword(
      user.password,
      newPassword,
    );
    if (isSamePassword) {
      throw new BadRequestException(
        'New password must be different from temporary password',
      );
    }

    const password = await this.passwordService.hashPassword(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.deleteMany({ where: { userId: user.id } });
      await tx.user.update({
        where: { id: user.id },
        data: {
          password,
          mustResetPassword: false,
          authVersion: { increment: 1 },
        },
      });
    });

    return { message: 'Password reset complete. You can now sign in.' };
  }
}
