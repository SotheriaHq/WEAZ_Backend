import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
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
  BrandMemberRole,
  BrandMemberStatus,
  AuthProvider,
  PasswordCredentialStatus,
  LoginCodePurpose,
  LegalAcceptanceSource,
} from '@prisma/client';
import {
  authUserSelect,
  profileUserSelect,
  toAuthUserResponse,
  AuthUser,
} from 'src/auth/helper/prisma-select.helper';
import {
  canonicalUserProfileSelect,
  getRejectedProfileMediaUrlReason,
  normalizeProfileMediaUrlForPersistence,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';
import { resolveRequiredBrandField } from 'src/common/brand-profile-source.helper';
import { TokenService } from './helper/general.helper';
import { Request, Response } from 'express';
import { UserHelperService } from './helper/user-helper.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { NotificationsService } from 'src/notifications/notifications.service';
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';
import { EmailService, type EnqueueEmailResult } from 'src/email/email.service';
import * as emailTemplates from 'src/email/email.templates';
import { createHash, randomBytes, randomInt } from 'crypto';
import { TrustedDeviceService } from './helper/trusted-device.service';
import {
  PasswordPolicyContext,
  validatePasswordPolicy,
} from './helper/password-policy.helper';
import {
  buildAdminPasswordResetLink,
  buildEmailChangeConfirmationLink,
  buildPasswordResetLink,
} from 'src/common/utils/auth-links';
import { maskEmailForLog } from 'src/common/utils/sensitive-log';
import {
  GoogleTokenVerifierService,
  VerifiedGoogleIdentity,
} from './helper/google-token-verifier.service';
import { LegalService } from 'src/legal/legal.service';
import { LegalAcceptanceInputDto } from 'src/legal/dto/legal-acceptance.dto';
import { PRODUCT_NAME } from 'src/common/branding/product-identity.constants';
import { MonitoringService } from 'src/monitoring/monitoring.service';

const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const RESET_REQUEST_SUPPRESSION_MS = 2 * 60 * 1000;
const EMAIL_LOGIN_CODE_TTL_MS = 10 * 60 * 1000;
const PASSWORD_SETUP_TOKEN_TTL_MS = 15 * 60 * 1000;
const EMAIL_LOGIN_CODE_MAX_ATTEMPTS = 5;
const INVISIBLE_AUTH_SPACING_REGEX =
  /[\u00A0\u1680\u180E\u2000-\u200D\u202F\u205F\u2060\u3000\uFEFF]/g;

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
    private readonly googleTokenVerifier: GoogleTokenVerifierService,
    private readonly legalService: LegalService,
    @Optional() private readonly monitoring?: MonitoringService,
  ) {}

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

  private hashSetupToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private generateEmailLoginCode(): string {
    return randomInt(0, 100_000_000).toString().padStart(8, '0');
  }

  private hasLocalPassword(user: {
    password?: string | null;
    passwordCredentialStatus?: PasswordCredentialStatus | null;
  }): boolean {
    const status =
      user.passwordCredentialStatus ?? PasswordCredentialStatus.ENABLED;
    return (
      status === PasswordCredentialStatus.ENABLED &&
      typeof user.password === 'string' &&
      user.password.length > 0
    );
  }

  private async verifyOptionalPassword(
    hashedPassword: string | null | undefined,
    plainPassword: string,
  ): Promise<boolean> {
    if (!hashedPassword) {
      return false;
    }
    return this.passwordService.verifyPassword(hashedPassword, plainPassword);
  }

  private isGoogleOnlyPasswordSetupCandidate(user: {
    password?: string | null;
    passwordCredentialStatus?: PasswordCredentialStatus | null;
    authIdentities?: Array<{ provider: AuthProvider }>;
  }): boolean {
    return (
      user.passwordCredentialStatus === PasswordCredentialStatus.NOT_SET &&
      !user.password &&
      (user.authIdentities ?? []).some(
        (identity) => identity.provider === AuthProvider.GOOGLE,
      )
    );
  }

  private resolveGoogleDisplayNames(identity: VerifiedGoogleIdentity): {
    firstName: string;
    lastName: string;
  } {
    const givenName = identity.givenName?.trim();
    const familyName = identity.familyName?.trim();
    if (givenName && familyName) {
      return { firstName: givenName, lastName: familyName };
    }

    const nameParts = String(identity.name ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (nameParts.length >= 2) {
      return {
        firstName: nameParts[0],
        lastName: nameParts.slice(1).join(' '),
      };
    }

    const emailLocalPart =
      identity.email
        .split('@')[0]
        ?.replace(/[._-]+/g, ' ')
        .trim() || PRODUCT_NAME;
    return {
      firstName: givenName || nameParts[0] || emailLocalPart,
      lastName: familyName || 'Member',
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
      `recipient=${maskEmailForLog(args.recipientEmail)} outboxId=${args.result.outboxId ?? 'n/a'} ` +
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

  private sanitizeEmailDispatchError(errorMessage?: string | null): string | null {
    const value = String(errorMessage ?? '').trim();
    if (!value) return null;

    return value
      .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '[email]')
      .replace(/(sk_(?:live|test)_[a-z0-9_]+)/gi, '[secret]')
      .replace(/(bearer\s+)[a-z0-9._-]+/gi, '$1[redacted]')
      .slice(0, 300);
  }

  private emitVerificationEmailDeliveryAlert(args: {
    scenarioKey: string;
    phase: 'signup' | 'resend';
    userId: string;
    recipientEmail: string;
    result: EnqueueEmailResult;
  }): void {
    if (
      args.result.dispatchStatus !== 'FAILED' &&
      args.result.dispatchStatus !== 'SUPPRESSED'
    ) {
      return;
    }

    this.monitoring?.emitAlert({
      category: 'AUTH',
      severity:
        args.result.dispatchStatus === 'FAILED' ? 'error' : 'warning',
      event: 'auth_email_verification_delivery_failed',
      title: 'Email verification delivery failed',
      message:
        args.result.dispatchStatus === 'FAILED'
          ? 'Auth verification email dispatch failed.'
          : 'Auth verification email dispatch was suppressed.',
      userId: args.userId,
      entityType: 'User',
      entityId: args.userId,
      dedupeKey: `auth_email_verification_delivery_failed:${args.userId}:${args.scenarioKey}:${args.result.dispatchStatus}`,
      metadata: {
        phase: args.phase,
        scenarioKey: args.scenarioKey,
        dispatchStatus: args.result.dispatchStatus,
        outboxId: args.result.outboxId ?? null,
        providerMessageId: args.result.providerMessageId ?? null,
        recipient: maskEmailForLog(args.recipientEmail),
        errorMessage: this.sanitizeEmailDispatchError(
          args.result.errorMessage,
        ),
      },
    });
  }

  private buildVerificationEmailMessage(result: EnqueueEmailResult): string {
    if (result.dispatchStatus === 'SENT') {
      return `Welcome to ${PRODUCT_NAME}! Verification email sent. Please check your inbox and spam folder.`;
    }

    if (result.dispatchStatus === 'FAILED') {
      return `Welcome to ${PRODUCT_NAME}, but we could not send your verification email right now. Use resend from your profile and try again shortly.`;
    }

    if (result.dispatchStatus === 'SUPPRESSED') {
      return `Welcome to ${PRODUCT_NAME}, but verification email delivery is temporarily suppressed for this address. Contact support if this persists.`;
    }

    return `Welcome to ${PRODUCT_NAME}! Verification email queued for delivery.`;
  }

  private extractClientIp(req: Request): string | null {
    return req.ip || req.socket?.remoteAddress || null;
  }

  private resolvePostVerificationNextPath(userType: UserType): string {
    return userType === UserType.BRAND
      ? '/profile?modal=brand-setup&modalOrigin=prompt'
      : '/profile';
  }

  private resolveRequestLocation(req: Request): string | null {
    const city =
      this.readHeaderValue(req, 'x-vercel-ip-city') ||
      this.readHeaderValue(req, 'cf-ipcity') ||
      this.readHeaderValue(req, 'x-appengine-city');
    const country =
      this.readHeaderValue(req, 'x-vercel-ip-country') ||
      this.readHeaderValue(req, 'cf-ipcountry') ||
      this.readHeaderValue(req, 'x-appengine-country');
    const parts = [city, country].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  private maskIpAddress(ipAddress?: string | null): string | null {
    const value = String(ipAddress ?? '').trim();
    if (!value) {
      return null;
    }

    if (value.includes(':')) {
      const segments = value.split(':').filter(Boolean);
      if (segments.length === 0) {
        return value;
      }
      return `${segments.slice(0, 2).join(':')}:xxxx:xxxx`;
    }

    const parts = value.split('.');
    if (parts.length !== 4) {
      return value;
    }

    return `${parts[0]}.${parts[1]}.xxx.xxx`;
  }

  private extractRefreshSessionId(
    rawRefreshToken?: string | null,
  ): string | null {
    if (!rawRefreshToken) {
      return null;
    }

    const [sessionId, secret] = String(rawRefreshToken).split('.');
    if (!sessionId || !secret) {
      return null;
    }

    return sessionId;
  }

  private async sendScenarioEmailIfAllowed(args: {
    userId: string;
    to: string;
    scenarioKey: string;
    subject: string;
    html: string;
    text: string;
    priority: EmailPriority;
    idempotencyKey?: string;
  }): Promise<void> {
    const allowed = await this.notifications.canSendScenarioEmail(
      args.userId,
      args.scenarioKey,
    );
    if (!allowed) {
      return;
    }

    const result = await this.emailService.send(
      args.to,
      args.subject,
      args.html,
      args.text,
      {
        recipientUserId: args.userId,
        scenarioKey: args.scenarioKey,
        priority: args.priority,
        idempotencyKey: args.idempotencyKey,
      },
    );

    this.logEmailDispatchOutcome({
      scenarioKey: args.scenarioKey,
      userId: args.userId,
      recipientEmail: args.to,
      result,
    });
  }

  private normalizeLoginIdentifier(value: string): string {
    return String(value ?? '')
      .normalize('NFKC')
      .replace(INVISIBLE_AUTH_SPACING_REGEX, '')
      .trim();
  }

  private readHeaderValue(req: Request, name: string): string {
    const value = req.headers[name];
    if (Array.isArray(value)) {
      return String(value[0] ?? '').trim();
    }
    return typeof value === 'string' ? value.trim() : '';
  }

  private describeSignupDevice(req: Request): string {
    const userAgent = this.readHeaderValue(req, 'user-agent').toLowerCase();

    const browser = userAgent.includes('edg/')
      ? 'Edge'
      : userAgent.includes('chrome/')
        ? 'Chrome'
        : userAgent.includes('safari/') && !userAgent.includes('chrome/')
          ? 'Safari'
          : userAgent.includes('firefox/')
            ? 'Firefox'
            : userAgent.includes('opr/')
              ? 'Opera'
              : 'Web browser';

    const os = userAgent.includes('windows')
      ? 'Windows'
      : userAgent.includes('mac os')
        ? 'macOS'
        : userAgent.includes('android')
          ? 'Android'
          : userAgent.includes('iphone') || userAgent.includes('ipad')
            ? 'iOS'
            : userAgent.includes('linux')
              ? 'Linux'
              : '';

    const deviceType =
      userAgent.includes('mobile') || userAgent.includes('android')
        ? 'Mobile'
        : 'Desktop';

    const osSegment = os ? ` on ${os}` : '';
    return `${browser}${osSegment} (${deviceType})`;
  }

  private describeSignupLocation(req: Request): string {
    const city =
      this.readHeaderValue(req, 'x-vercel-ip-city') ||
      this.readHeaderValue(req, 'cf-ipcity') ||
      this.readHeaderValue(req, 'x-appengine-city');
    const region =
      this.readHeaderValue(req, 'x-vercel-ip-country-region') ||
      this.readHeaderValue(req, 'cf-region') ||
      this.readHeaderValue(req, 'x-appengine-region');
    const country =
      this.readHeaderValue(req, 'x-vercel-ip-country') ||
      this.readHeaderValue(req, 'cf-ipcountry') ||
      this.readHeaderValue(req, 'x-appengine-country');

    const locationParts = [city, region, country].filter(Boolean);
    if (locationParts.length) {
      return locationParts.join(', ');
    }

    const fallbackIp = this.extractClientIp(req);
    return fallbackIp ? `IP ${fallbackIp}` : 'Unknown location';
  }

  private resolveSignupDisplayName(user: AuthUser): string {
    const brandName = resolveRequiredBrandField(user, 'brandFullName').trim();
    if (brandName) {
      return brandName;
    }

    const fullName = `${resolveRequiredProfileField(
      user,
      'firstName',
    )} ${resolveRequiredProfileField(user, 'lastName')}`.trim();
    if (fullName) {
      return fullName;
    }

    return user.username;
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

      this.legalService.assertRequiredCurrentAcceptances(
        signupDto.legalAcceptances,
        this.legalService.getRequiredSignupDocuments(),
      );

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

      // Generate single-use email verification token
      const verificationToken =
        this.emailVerificationHelper.generateVerificationCode();
      // Ensure database-required name fields are present. Prisma User model requires firstName and lastName.
      const dbFirstName = signupDto.firstName ?? '';
      const dbLastName = signupDto.lastName ?? '';

      const createdAt = new Date();
      const brandId = signupDto.type === UserType.BRAND ? uuidv4() : null;

      const user = await this.prisma
        .$transaction(async (tx) => {
          const createdUser = await tx.user.create({
            data: {
              id: uuidv4(),
              username,
              // Never trust role from client-controlled signup payload.
              role: Role.User,
              email: signupDto.email,
              password: hashedPassword,
              passwordCredentialStatus: PasswordCredentialStatus.ENABLED,
              type: signupDto.type ?? UserType.REGULAR,
              emailVerificationCode: verificationToken,
              isEmailVerified: false,
              userProfile: {
                create: {
                  firstName: dbFirstName,
                  lastName: dbLastName,
                  profileImage: signupDto.profileImage,
                },
              },
              ...(signupDto.type === UserType.BRAND && brandId
                ? {
                    brand: {
                      create: {
                        id: brandId,
                        name: signupDto.brandFullName!,
                        industriNumber,
                        storeNameLastChangedAt: createdAt,
                        currency: 'NGN',
                      },
                    },
                  }
                : {}),
            },
            select: authUserSelect,
          });

          await this.legalService.recordAcceptedDocuments({
            tx,
            userId: createdUser.id,
            acceptances: signupDto.legalAcceptances,
            requiredKeys: this.legalService.getRequiredSignupDocuments(),
            source: LegalAcceptanceSource.SIGNUP,
            surface: 'signup',
            accountType: signupDto.type ?? UserType.REGULAR,
            req,
          });

          if (signupDto.type === UserType.BRAND && brandId) {
            await tx.brandMember.create({
              data: {
                id: uuidv4(),
                brandId,
                userId: createdUser.id,
                role: BrandMemberRole.OWNER,
                status: BrandMemberStatus.ACTIVE,
                joinedAt: createdAt,
              },
            });

            return tx.user.findUnique({
              where: { id: createdUser.id },
              select: authUserSelect,
            });
          }

          return createdUser;
        })
        .catch((dbError) => {
          this.logger.error('Database error creating user:', dbError);

          if (dbError.code === 'P2002') {
            throw new BadRequestException('Email or CAC number already exists');
          }
          throw new BadRequestException('Failed to create user account');
        });

      if (!user) {
        throw new BadRequestException('Failed to create user account');
      }

      const postVerificationNextPath = this.resolvePostVerificationNextPath(
        user.type,
      );

      // Send verification email
      const verificationLink =
        this.emailVerificationHelper.generateVerificationLink(
          verificationToken,
          postVerificationNextPath,
        );
      const verificationEmail = emailTemplates.emailVerificationEmail(
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
          idempotencyKey: `auth:email-verification:${user.id}:${verificationToken}`,
          dispatchImmediately: true,
        },
      );
      this.logEmailDispatchOutcome({
        scenarioKey: 'auth.email_verification',
        userId: user.id,
        recipientEmail: user.email,
        result: verificationDispatchResult,
      });
      this.emitVerificationEmailDeliveryAlert({
        scenarioKey: 'auth.email_verification',
        phase: 'signup',
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

      const signupRecordedAtIso = new Date().toISOString();
      const signupDevice = this.describeSignupDevice(req);
      const signupLocation = this.describeSignupLocation(req);
      const signupDisplayName = this.resolveSignupDisplayName(user);

      // Notify SIGNUP event (account created) without blocking signup latency.
      void this.notifications
        .create(user.id, NotificationType.SIGNUP, {
          payload: {
            action: 'SIGNUP',
            email: user.email,
            displayName: signupDisplayName,
            username: user.username,
            createdAtIso: signupRecordedAtIso,
            device: signupDevice,
            location: signupLocation,
            targetUrl: '/profile',
          },
        })
        .catch(() => undefined);

      return {
        user: toAuthUserResponse(user),
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        message: this.buildVerificationEmailMessage(
          verificationDispatchResult,
        ),
        verificationEmail: {
          status: verificationDispatchResult.dispatchStatus,
          message: this.buildVerificationEmailMessage(
            verificationDispatchResult,
          ),
        },
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
      const identifier = this.normalizeLoginIdentifier(
        String(dto.identifier ?? dto.email ?? ''),
      );
      const user = await this.validateUser(identifier, dto.password);
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

  async googleAuth(
    dto: {
      idToken: string;
      type?: UserType;
      brandFullName?: string;
      legalAcceptances?: LegalAcceptanceInputDto[];
    },
    req: Request,
    res: Response,
  ) {
    const identity = await this.googleTokenVerifier.verifyIdToken(dto.idToken);
    const requestedType = dto.type ?? UserType.REGULAR;
    const createdAt = new Date();

    if (requestedType === UserType.BRAND && !dto.brandFullName?.trim()) {
      throw new BadRequestException('Brand full name is required');
    }

    const user = await this.prisma
      .$transaction(async (tx) => {
        const existingIdentity = await tx.authIdentity.findUnique({
          where: {
            provider_providerSubject: {
              provider: AuthProvider.GOOGLE,
              providerSubject: identity.providerSubject,
            },
          },
          select: {
            id: true,
            email: true,
            emailVerified: true,
            user: { select: authUserSelect },
          },
        });

        if (existingIdentity) {
          if (existingIdentity.user.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException(
              'User account is suspended or deactivated',
            );
          }

          if (
            existingIdentity.email !== identity.email ||
            existingIdentity.emailVerified !== identity.emailVerified
          ) {
            await tx.authIdentity.update({
              where: { id: existingIdentity.id },
              data: {
                email: identity.email,
                emailVerified: identity.emailVerified,
              },
            });
          }

          return existingIdentity.user;
        }

        const existingUser = await tx.user.findUnique({
          where: { email: identity.email },
          select: authUserSelect,
        });

        if (existingUser) {
          if (existingUser.status !== UserStatus.ACTIVE) {
            throw new UnauthorizedException(
              'User account is suspended or deactivated',
            );
          }

          await tx.authIdentity.create({
            data: {
              userId: existingUser.id,
              provider: AuthProvider.GOOGLE,
              providerSubject: identity.providerSubject,
              email: identity.email,
              emailVerified: identity.emailVerified,
            },
          });

          return existingUser;
        }

        const displayNames = this.resolveGoogleDisplayNames(identity);
        const username =
          requestedType === UserType.BRAND && dto.brandFullName?.trim()
            ? await this.userHelperService.generateUsernameFromBrand(
                dto.brandFullName.trim(),
              )
            : await this.userHelperService.generateUniqueUsername(
                displayNames.firstName,
                displayNames.lastName,
              );
        const brandId = requestedType === UserType.BRAND ? uuidv4() : null;
        const industriNumber =
          requestedType === UserType.BRAND
            ? await this.userHelperService.generateIndustriNumber()
            : null;

        this.legalService.assertRequiredCurrentAcceptances(
          dto.legalAcceptances,
          this.legalService.getRequiredSignupDocuments(),
        );

        const createdUser = await tx.user.create({
          data: {
            id: uuidv4(),
            username,
            role: Role.User,
            email: identity.email,
            password: null,
            passwordCredentialStatus: PasswordCredentialStatus.NOT_SET,
            type: requestedType,
            isEmailVerified: true,
            emailVerificationCode: null,
            userProfile: {
              create: {
                firstName: displayNames.firstName,
                lastName: displayNames.lastName,
                profileImage: identity.picture,
              },
            },
            authIdentities: {
              create: {
                provider: AuthProvider.GOOGLE,
                providerSubject: identity.providerSubject,
                email: identity.email,
                emailVerified: identity.emailVerified,
              },
            },
            ...(requestedType === UserType.BRAND && brandId
              ? {
                  brand: {
                    create: {
                      id: brandId,
                      name: dto.brandFullName!.trim(),
                      industriNumber,
                      storeNameLastChangedAt: createdAt,
                      currency: 'NGN',
                    },
                  },
                }
              : {}),
          },
          select: authUserSelect,
        });

        await this.legalService.recordAcceptedDocuments({
          tx,
          userId: createdUser.id,
          acceptances: dto.legalAcceptances,
          requiredKeys: this.legalService.getRequiredSignupDocuments(),
          source: LegalAcceptanceSource.GOOGLE_SIGNUP,
          surface: 'google-signup',
          accountType: requestedType,
          req,
        });

        if (requestedType === UserType.BRAND && brandId) {
          await tx.brandMember.create({
            data: {
              id: uuidv4(),
              brandId,
              userId: createdUser.id,
              role: BrandMemberRole.OWNER,
              status: BrandMemberStatus.ACTIVE,
              joinedAt: createdAt,
            },
          });

          const reloaded = await tx.user.findUnique({
            where: { id: createdUser.id },
            select: authUserSelect,
          });
          if (!reloaded) {
            throw new BadRequestException('Failed to create user account');
          }
          return reloaded;
        }

        return createdUser;
      })
      .catch((error) => {
        if (error?.code === 'P2002') {
          throw new BadRequestException(
            'Google sign-in could not be completed. Please retry.',
          );
        }
        throw error;
      });

    const tokenResult = await this.tokenService.generateTokens(user, req, res);
    const deviceResult = await this.trustedDeviceService.recordLoginDevice(
      user.id,
      req,
    );
    void this.notifications
      .create(user.id, NotificationType.LOGIN, {
        payload: {
          ip: this.extractClientIp(req),
          userAgent: req.headers?.['user-agent'] ?? null,
          newDevice: deviceResult.isNewDevice,
          method: 'GOOGLE',
        },
      })
      .catch(() => undefined);

    return {
      user: toAuthUserResponse(user),
      accessToken: tokenResult.accessToken,
      ...(tokenResult.refreshToken
        ? { refreshToken: tokenResult.refreshToken }
        : {}),
      message: 'Welcome Back',
    };
  }

  async getLoginOptions(email: string) {
    const genericResponse = {
      requestId: uuidv4(),
      methods: {
        password: false,
        google: false,
        passwordSetupAvailable: false,
      },
      message: 'Continue with an available sign-in method.',
    };

    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException('Email is required');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        status: true,
        password: true,
        passwordCredentialStatus: true,
        authIdentities: {
          select: { provider: true },
        },
      },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      return genericResponse;
    }

    const hasGoogle = user.authIdentities.some(
      (identity) => identity.provider === AuthProvider.GOOGLE,
    );
    return {
      requestId: genericResponse.requestId,
      methods: {
        password: this.hasLocalPassword(user),
        google: hasGoogle,
        passwordSetupAvailable:
          hasGoogle &&
          user.passwordCredentialStatus === PasswordCredentialStatus.NOT_SET &&
          !user.password,
      },
      message: genericResponse.message,
    };
  }

  async requestEmailLoginCode(
    email: string,
    purpose: LoginCodePurpose = LoginCodePurpose.PASSWORD_SETUP,
  ) {
    const genericResponse = {
      message:
        purpose === LoginCodePurpose.DIRECT_LOGIN
          ? 'If this account exists, a sign-in code has been sent.'
          : 'If this account can set up a password, a verification code has been sent.',
    };

    if (
      purpose !== LoginCodePurpose.PASSWORD_SETUP &&
      purpose !== LoginCodePurpose.DIRECT_LOGIN
    ) {
      throw new BadRequestException('Unsupported email login code purpose');
    }

    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException('Email is required');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        email: true,
        status: true,
        password: true,
        passwordCredentialStatus: true,
        authIdentities: {
          select: { provider: true },
        },
      },
    });

    const hasGoogleIdentity = user?.authIdentities?.some(
      (i) => i.provider === AuthProvider.GOOGLE,
    );

    if (purpose === LoginCodePurpose.DIRECT_LOGIN) {
      if (!user || user.status !== UserStatus.ACTIVE || !hasGoogleIdentity) {
        return genericResponse;
      }
    } else {
      if (
        !user ||
        user.status !== UserStatus.ACTIVE ||
        !this.isGoogleOnlyPasswordSetupCandidate(user)
      ) {
        return genericResponse;
      }
    }

    const code = this.generateEmailLoginCode();
    const codeHash = await this.passwordService.hashPassword(code);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EMAIL_LOGIN_CODE_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      await tx.emailLoginCode.updateMany({
        where: {
          userId: user.id,
          purpose,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });

      await tx.emailLoginCode.create({
        data: {
          id: uuidv4(),
          userId: user.id,
          purpose,
          codeHash,
          expiresAt,
        },
      });
    });

    const emailContent = emailTemplates.emailLoginCodeEmail(
      code,
      this.emailService.getAppName(),
    );
    const scenarioKey =
      purpose === LoginCodePurpose.DIRECT_LOGIN
        ? 'auth.email_login_code.direct_login'
        : 'auth.email_login_code.password_setup';
    await this.sendScenarioEmailIfAllowed({
      userId: user.id,
      to: user.email,
      scenarioKey,
      subject: emailContent.subject,
      html: emailContent.html,
      text: emailContent.text,
      priority: EmailPriority.P0_SECURITY,
      idempotencyKey: `auth:email-login-code:${user.id}:${expiresAt.getTime()}`,
    });

    return genericResponse;
  }

  async confirmEmailLoginCode(
    email: string,
    code: string,
    purpose: LoginCodePurpose = LoginCodePurpose.PASSWORD_SETUP,
    req?: Request,
    res?: Response,
  ) {
    if (
      purpose !== LoginCodePurpose.PASSWORD_SETUP &&
      purpose !== LoginCodePurpose.DIRECT_LOGIN
    ) {
      throw new BadRequestException('Unsupported email login code purpose');
    }

    const normalizedEmail = email?.trim().toLowerCase();
    const submittedCode = code?.trim();
    if (!normalizedEmail || !submittedCode) {
      throw new BadRequestException('Email and verification code are required');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        status: true,
        password: true,
        passwordCredentialStatus: true,
        authIdentities: {
          select: { provider: true },
        },
      },
    });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new BadRequestException('Invalid or expired verification code');
    }
    if (purpose === LoginCodePurpose.DIRECT_LOGIN) {
      const hasGoogle = user.authIdentities?.some(
        (i) => i.provider === AuthProvider.GOOGLE,
      );
      if (!hasGoogle) {
        throw new BadRequestException('Invalid or expired verification code');
      }
    } else if (!this.isGoogleOnlyPasswordSetupCandidate(user)) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const now = new Date();
    const activeCode = await this.prisma.emailLoginCode.findFirst({
      where: {
        userId: user.id,
        purpose,
        usedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!activeCode || activeCode.attempts >= EMAIL_LOGIN_CODE_MAX_ATTEMPTS) {
      throw new BadRequestException('Invalid or expired verification code');
    }

    const valid = await this.verifyOptionalPassword(
      activeCode.codeHash,
      submittedCode,
    ).catch(() => false);
    if (!valid) {
      await this.prisma.emailLoginCode.update({
        where: { id: activeCode.id },
        data: {
          attempts: { increment: 1 },
          ...(activeCode.attempts + 1 >= EMAIL_LOGIN_CODE_MAX_ATTEMPTS
            ? { usedAt: now }
            : {}),
        },
      });
      throw new BadRequestException('Invalid or expired verification code');
    }

    if (purpose === LoginCodePurpose.DIRECT_LOGIN) {
      await this.prisma.$transaction(async (tx) => {
        const claimed = await tx.emailLoginCode.updateMany({
          where: { id: activeCode.id, usedAt: null, expiresAt: { gt: now } },
          data: { usedAt: now },
        });
        if (claimed.count !== 1) {
          throw new BadRequestException('Invalid or expired verification code');
        }
      });

      const fullUser = await this.prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: authUserSelect,
      });

      const tokenResult = await this.tokenService.generateTokens(
        fullUser,
        req!,
        res!,
      );
      const deviceResult = await this.trustedDeviceService.recordLoginDevice(
        user.id,
        req!,
      );
      void this.notifications
        .create(user.id, NotificationType.LOGIN, {
          payload: {
            ip: this.extractClientIp(req!),
            userAgent: req!.headers?.['user-agent'] ?? null,
            newDevice: deviceResult.isNewDevice,
            method: 'EMAIL_CODE',
          },
        })
        .catch(() => undefined);

      return {
        user: toAuthUserResponse(fullUser),
        accessToken: tokenResult.accessToken,
        ...(tokenResult.refreshToken
          ? { refreshToken: tokenResult.refreshToken }
          : {}),
      };
    }

    const rawSetupToken = randomBytes(32).toString('hex');
    const tokenHash = this.hashSetupToken(rawSetupToken);
    const expiresAt = new Date(now.getTime() + PASSWORD_SETUP_TOKEN_TTL_MS);

    await this.prisma.$transaction(async (tx) => {
      const claimedCode = await tx.emailLoginCode.updateMany({
        where: {
          id: activeCode.id,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });
      if (claimedCode.count !== 1) {
        throw new BadRequestException('Invalid or expired verification code');
      }

      await tx.passwordSetupToken.updateMany({
        where: {
          userId: user.id,
          usedAt: null,
          expiresAt: { gt: now },
        },
        data: { usedAt: now },
      });

      await tx.passwordSetupToken.create({
        data: {
          id: uuidv4(),
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      });
    });

    return {
      passwordSetupToken: rawSetupToken,
      expiresInSeconds: Math.floor(PASSWORD_SETUP_TOKEN_TTL_MS / 1000),
    };
  }

  async setupPassword(passwordSetupToken: string, newPassword: string) {
    const rawToken = passwordSetupToken?.trim();
    if (!rawToken || !newPassword) {
      throw new BadRequestException(
        'Password setup token and new password are required',
      );
    }

    const tokenHash = this.hashSetupToken(rawToken);
    const now = new Date();
    const setupToken = await this.prisma.passwordSetupToken.findFirst({
      where: {
        tokenHash,
        usedAt: null,
        expiresAt: { gt: now },
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            username: true,
            status: true,
            password: true,
            passwordCredentialStatus: true,
            authIdentities: {
              select: { provider: true },
            },
            userProfile: { select: canonicalUserProfileSelect },
            brand: { select: { name: true } },
          },
        },
      },
    });

    if (
      !setupToken ||
      setupToken.user.status !== UserStatus.ACTIVE ||
      !this.isGoogleOnlyPasswordSetupCandidate(setupToken.user)
    ) {
      throw new UnauthorizedException(
        'Invalid or expired password setup token',
      );
    }

    validatePasswordPolicy(
      newPassword,
      this.buildPasswordPolicyContext({
        email: setupToken.user.email,
        username: setupToken.user.username,
        brandFullName: resolveRequiredBrandField(
          setupToken.user,
          'brandFullName',
        ),
        firstName: resolveRequiredProfileField(setupToken.user, 'firstName'),
        lastName: resolveRequiredProfileField(setupToken.user, 'lastName'),
      }),
    );

    const password = await this.passwordService.hashPassword(newPassword);

    await this.prisma.$transaction(
      async (tx) => {
        const claimedToken = await tx.passwordSetupToken.updateMany({
          where: {
            id: setupToken.id,
            usedAt: null,
            expiresAt: { gt: now },
          },
          data: { usedAt: now },
        });
        if (claimedToken.count !== 1) {
          throw new UnauthorizedException(
            'Invalid or expired password setup token',
          );
        }

        await tx.refreshToken.deleteMany({
          where: { userId: setupToken.userId },
        });
        await tx.user.update({
          where: { id: setupToken.userId },
          data: {
            password,
            passwordCredentialStatus: PasswordCredentialStatus.ENABLED,
            mustResetPassword: false,
            authVersion: { increment: 1 },
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    const passwordChangedEmail =
      emailTemplates.passwordChangedSecurityAlertEmail(
        this.emailService.getAppName(),
      );
    await this.sendScenarioEmailIfAllowed({
      userId: setupToken.userId,
      to: setupToken.user.email,
      scenarioKey: 'auth.password.changed',
      subject: passwordChangedEmail.subject,
      html: passwordChangedEmail.html,
      text: passwordChangedEmail.text,
      priority: EmailPriority.P0_SECURITY,
      idempotencyKey: `auth:password-setup:${setupToken.userId}:${setupToken.id}`,
    });

    return {
      message: 'Password set successfully. Sign in with your new password.',
    };
  }

  async linkGoogle(userId: string, idToken: string) {
    const identity = await this.googleTokenVerifier.verifyIdToken(idToken);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        status: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    if (user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException(
        'User account is suspended or deactivated',
      );
    }
    if (user.email.trim().toLowerCase() !== identity.email) {
      throw new BadRequestException(
        `Google account email must match your ${PRODUCT_NAME} email`,
      );
    }

    const existing = await this.prisma.authIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider: AuthProvider.GOOGLE,
          providerSubject: identity.providerSubject,
        },
      },
      select: { userId: true },
    });

    if (existing) {
      if (existing.userId === user.id) {
        return { message: 'Google sign-in is already linked.' };
      }
      throw new BadRequestException('Google sign-in is already linked.');
    }

    await this.prisma.authIdentity.create({
      data: {
        userId: user.id,
        provider: AuthProvider.GOOGLE,
        providerSubject: identity.providerSubject,
        email: identity.email,
        emailVerified: identity.emailVerified,
      },
    });

    return { message: 'Google sign-in linked.' };
  }

  async getTrustedDevices(userId: string) {
    return this.trustedDeviceService.listDevices(userId);
  }

  async revokeTrustedDevice(userId: string, deviceId: string) {
    return this.trustedDeviceService.revokeDevice(userId, deviceId);
  }

  async listSecuritySessions(
    userId: string,
    currentRawRefreshToken?: string | null,
  ) {
    const currentSessionId = this.extractRefreshSessionId(
      currentRawRefreshToken,
    );
    const sessions = await this.prisma.refreshToken.findMany({
      where: { userId },
      orderBy: { lastUsedAt: 'desc' },
      take: 25,
      select: {
        id: true,
        userAgent: true,
        ipAddress: true,
        locationLabel: true,
        createdAt: true,
        lastUsedAt: true,
        expiresAt: true,
      },
    } as any);

    return sessions.map((session) => ({
      id: session.id,
      userAgent: session.userAgent,
      ipAddressMasked: this.maskIpAddress(session.ipAddress),
      location: (session as any).locationLabel ?? null,
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      expiresAt: session.expiresAt,
      isCurrentSession:
        currentSessionId != null && session.id === currentSessionId,
    }));
  }

  async revokeSecuritySession(
    userId: string,
    sessionId: string,
    currentRawRefreshToken?: string | null,
  ) {
    const currentSessionId = this.extractRefreshSessionId(
      currentRawRefreshToken,
    );
    if (currentSessionId && sessionId === currentSessionId) {
      throw new BadRequestException('Use logout to end the current session');
    }

    const result = await this.prisma.refreshToken.deleteMany({
      where: { id: sessionId, userId },
    });

    return { success: result.count > 0 };
  }

  async logoutOtherSessions(
    userId: string,
    currentRawRefreshToken?: string | null,
  ) {
    return this.tokenService.revokeOtherRefreshTokens(
      userId,
      currentRawRefreshToken,
    );
  }

  // Validates user credentials for login
  async validateUser(identifier: string, password: string) {
    const normalizedIdentifier = this.normalizeLoginIdentifier(identifier);
    const normalizedLower = normalizedIdentifier?.toLowerCase();

    if (!normalizedIdentifier || !normalizedLower) {
      return null;
    }

    const looksLikeEmail = normalizedIdentifier.includes('@');

    try {
      const user = await this.prisma.user
        .findFirst({
          where: {
            ...(looksLikeEmail
              ? {
                  email: {
                    equals: normalizedLower,
                    mode: 'insensitive',
                  },
                }
              : {
                  OR: [
                    {
                      username: {
                        equals: normalizedIdentifier,
                        mode: 'insensitive',
                      },
                    },
                    {
                      email: {
                        equals: normalizedLower,
                        mode: 'insensitive',
                      },
                    },
                  ],
                }),
          },
          select: {
            ...authUserSelect,
            password: true,
            passwordCredentialStatus: true,
          },
        })
        .catch((dbError) => {
          this.logger.error('Database error during user validation:', dbError);
          return null;
        });

      if (!user) {
        return null;
      }

      const {
        password: hashedPassword,
        passwordCredentialStatus,
        ...publicUser
      } = user;

      if (
        !this.hasLocalPassword({
          password: hashedPassword,
          passwordCredentialStatus,
        })
      ) {
        return null;
      }

      const isPasswordValid = await this.passwordService
        .verifyPassword(hashedPassword!, password)
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

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const forbiddenFields = [
      'password',
      'email',
      'role',
      'type',
      'status',
      'isActive',
      'isEmailVerified',
      'authVersion',
      'mustResetPassword',
      'brandFullName',
      'brandDescription',
      'brandCountry',
      'brandState',
      'brandCity',
      'brandTags',
      'brandBusinessType',
      'socialInstagram',
      'socialFacebook',
      'socialTwitter',
      'socialWebsite',
      'cacNumber',
      'tin',
      'ceoNin',
      'ceoFirstName',
      'ceoLastName',
      'companyLocation',
      'industriNumber',
    ] as const;
    type ForbiddenProfileUpdateField = (typeof forbiddenFields)[number];
    type AllowedProfileUpdateField =
      | 'firstName'
      | 'lastName'
      | 'phoneNumber'
      | 'address'
      | 'profileImage'
      | 'profileImageId'
      | 'bannerImage'
      | 'bannerImageId';
    type AllowedProfileUpdateData = Partial<
      Record<AllowedProfileUpdateField, string | null>
    >;
    const dtoRecord = dto as UpdateProfileDto &
      Partial<Record<ForbiddenProfileUpdateField, unknown>>;
    const attemptedForbiddenField = forbiddenFields.find(
      (field) => dtoRecord[field] !== undefined,
    );
    if (attemptedForbiddenField) {
      throw new BadRequestException(
        `${attemptedForbiddenField} cannot be updated here`,
      );
    }

    const profileData: AllowedProfileUpdateData = {};
    const assignString = (
      field: Extract<
        AllowedProfileUpdateField,
        'firstName' | 'lastName' | 'phoneNumber' | 'address'
      >,
    ) => {
      const value = dto[field];
      if (value !== undefined) {
        profileData[field] = typeof value === 'string' ? value.trim() : value;
      }
    };

    assignString('firstName');
    assignString('lastName');
    assignString('phoneNumber');
    assignString('address');

    const assignMediaUrl = (
      field: Extract<
        AllowedProfileUpdateField,
        'profileImage' | 'bannerImage'
      >,
    ) => {
      const value = dto[field];
      if (value === undefined) return;

      const rejectedReason = getRejectedProfileMediaUrlReason(value);
      if (rejectedReason) {
        throw new BadRequestException(
          `${field} must reference a persisted uploaded file, not a temporary display URL`,
        );
      }

      profileData[field] =
        normalizeProfileMediaUrlForPersistence(value) ?? null;
    };

    assignMediaUrl('profileImage');
    if (dto.profileImageId !== undefined) {
      profileData.profileImageId = dto.profileImageId;
    }
    assignMediaUrl('bannerImage');
    if (dto.bannerImageId !== undefined) {
      profileData.bannerImageId = dto.bannerImageId;
    }

    try {
      const updatedUser = await this.prisma.$transaction(async (tx) => {
        const existingUser = await tx.user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            userProfile: {
              select: {
                firstName: true,
                lastName: true,
                profileVisibility: true,
              },
            },
          },
        });

        if (!existingUser) {
          throw new UnauthorizedException('User not found');
        }

        const hasProfileUpdates = Object.keys(profileData).length > 0;
        if (hasProfileUpdates) {
          await tx.userProfile.upsert({
            where: { userId },
            create: {
              userId,
              firstName:
                (profileData.firstName as string | undefined) ??
                existingUser.userProfile?.firstName ??
                '',
              lastName:
                (profileData.lastName as string | undefined) ??
                existingUser.userProfile?.lastName ??
                '',
              phoneNumber:
                (profileData.phoneNumber as string | null | undefined) ?? null,
              address:
                (profileData.address as string | null | undefined) ?? null,
              profileImage:
                (profileData.profileImage as string | null | undefined) ?? null,
              profileImageId:
                (profileData.profileImageId as string | null | undefined) ??
                null,
              bannerImage:
                (profileData.bannerImage as string | null | undefined) ?? null,
              bannerImageId:
                (profileData.bannerImageId as string | null | undefined) ??
                null,
              profileVisibility:
                existingUser.userProfile?.profileVisibility ?? 'UNLOCKED',
            },
            update: profileData,
          });
        }

        return tx.user.findUnique({
          where: { id: userId },
          select: profileUserSelect,
        });
      });
      if (!updatedUser) {
        throw new UnauthorizedException('User not found');
      }
      return toAuthUserResponse(updatedUser);
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }
      this.logger.error('Profile update error:', error);
      throw new BadRequestException('Failed to update profile');
    }
  }

  async verifyEmailByToken(token: string) {
    const verificationToken = token?.trim();
    if (!verificationToken) {
      throw new BadRequestException('Verification token is required');
    }

    const user = await this.prisma.user.findUnique({
      where: { emailVerificationCode: verificationToken },
    });
    if (!user) {
      throw new BadRequestException('Invalid or expired verification link');
    }
    if (user.isEmailVerified) {
      return { message: 'Email already verified' };
    }

    await this.prisma.user.update({
      where: { id: user.id },
      // Keep token so repeated clicks remain idempotent and return
      // "Email already verified" instead of confusing invalid-link errors.
      data: { isEmailVerified: true },
    });

    try {
      await this.notifications.create(user.id, NotificationType.SIGNUP, {
        payload: { action: 'EMAIL_VERIFIED', targetUrl: '/' },
      });
    } catch {
      // best-effort notification
    }

    return { message: 'Email verified successfully' };
  }

  async resendVerificationEmail(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        type: true,
        isEmailVerified: true,
        emailVerificationCode: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.isEmailVerified) {
      return { message: 'Email already verified' };
    }

    const verificationToken =
      String(user.emailVerificationCode ?? '').trim() ||
      this.emailVerificationHelper.generateVerificationCode();

    if (!user.emailVerificationCode) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerificationCode: verificationToken },
      });
    }

    const verificationLink =
      this.emailVerificationHelper.generateVerificationLink(
        verificationToken,
        this.resolvePostVerificationNextPath(user.type),
      );
    const verificationEmail = emailTemplates.emailVerificationEmail(
      verificationLink,
      this.emailService.getAppName(),
    );

    const dispatchResult = await this.emailService.send(
      user.email,
      verificationEmail.subject,
      verificationEmail.html,
      verificationEmail.text,
      {
        recipientUserId: user.id,
        scenarioKey: 'auth.email_verification.resend',
        priority: EmailPriority.P1_TRANSACTIONAL,
        dispatchImmediately: true,
      },
    );

    this.logEmailDispatchOutcome({
      scenarioKey: 'auth.email_verification.resend',
      userId: user.id,
      recipientEmail: user.email,
      result: dispatchResult,
    });
    this.emitVerificationEmailDeliveryAlert({
      scenarioKey: 'auth.email_verification.resend',
      phase: 'resend',
      userId: user.id,
      recipientEmail: user.email,
      result: dispatchResult,
    });

    if (dispatchResult.dispatchStatus === 'FAILED') {
      throw new ServiceUnavailableException(
        'Unable to send verification email right now. Please try again shortly.',
      );
    }

    if (dispatchResult.dispatchStatus === 'SUPPRESSED') {
      throw new BadRequestException(
        'Verification email is temporarily suppressed for this address. Contact support if this persists.',
      );
    }

    return {
      message:
        'Verification email sent. Please check your inbox and spam folder.',
    };
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
        payload: { action: 'EMAIL_VERIFIED', targetUrl: '/' },
      });
    } catch {}
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
        payload: { action: 'EMAIL_VERIFIED', targetUrl: '/' },
      });
    } catch {}
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

  async requestEmailChange(
    userId: string,
    newEmail: string,
    currentPassword: string,
  ) {
    const normalizedEmail = newEmail.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException('New email is required');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        password: true,
        passwordCredentialStatus: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (user.email === normalizedEmail) {
      throw new BadRequestException(
        'New email must be different from your current email',
      );
    }

    if (!this.hasLocalPassword(user)) {
      throw new BadRequestException(
        'Set a password before changing your email address',
      );
    }

    const passwordValid = await this.verifyOptionalPassword(
      user.password,
      currentPassword,
    );
    if (!passwordValid) {
      throw new UnauthorizedException('Incorrect password');
    }

    const existing = await this.prisma.user.findFirst({
      where: {
        OR: [{ email: normalizedEmail }, { pendingEmail: normalizedEmail }],
        id: { not: userId },
      },
      select: { id: true },
    } as any);
    if (existing) {
      throw new BadRequestException('That email address is already in use');
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        pendingEmail: normalizedEmail,
        pendingEmailTokenHash: tokenHash,
        pendingEmailExpiresAt: expiresAt,
      },
    } as any);

    const confirmLink = buildEmailChangeConfirmationLink(rawToken);
    const emailContent = emailTemplates.confirmEmailChangeEmail(
      confirmLink,
      normalizedEmail,
      this.emailService.getAppName(),
    );
    const result = await this.emailService.send(
      normalizedEmail,
      emailContent.subject,
      emailContent.html,
      emailContent.text,
      {
        recipientUserId: userId,
        scenarioKey: 'auth.email_change.confirm',
        priority: EmailPriority.P0_SECURITY,
        idempotencyKey: `auth:email-change:${userId}:${tokenHash}`,
      },
    );
    this.logEmailDispatchOutcome({
      scenarioKey: 'auth.email_change.confirm',
      userId,
      recipientEmail: normalizedEmail,
      result,
    });

    return {
      message: `A confirmation link has been sent to ${normalizedEmail}. Your email will update once confirmed.`,
      pendingEmail: normalizedEmail,
    };
  }

  async confirmEmailChange(token: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const user = await this.prisma.user.findFirst({
      where: {
        pendingEmailTokenHash: tokenHash,
        pendingEmailExpiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        email: true,
        pendingEmail: true,
      },
    } as any);

    if (!user || !user.pendingEmail) {
      throw new BadRequestException('Invalid or expired email change link');
    }

    const previousEmail = user.email;
    const nextEmail = user.pendingEmail;

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        email: nextEmail,
        pendingEmail: null,
        pendingEmailTokenHash: null,
        pendingEmailExpiresAt: null,
        isEmailVerified: true,
      },
    } as any);

    const changedEmail = emailTemplates.emailChangedSecurityAlertEmail(
      previousEmail,
      nextEmail,
      this.emailService.getAppName(),
    );

    await this.sendScenarioEmailIfAllowed({
      userId: user.id,
      to: previousEmail,
      scenarioKey: 'auth.email.changed',
      subject: changedEmail.subject,
      html: changedEmail.html,
      text: changedEmail.text,
      priority: EmailPriority.P0_SECURITY,
      idempotencyKey: `auth:email-changed:old:${user.id}:${tokenHash}`,
    });

    await this.sendScenarioEmailIfAllowed({
      userId: user.id,
      to: nextEmail,
      scenarioKey: 'auth.email.changed',
      subject: changedEmail.subject,
      html: changedEmail.html,
      text: changedEmail.text,
      priority: EmailPriority.P0_SECURITY,
      idempotencyKey: `auth:email-changed:new:${user.id}:${tokenHash}`,
    });

    return { message: 'Email updated successfully' };
  }

  async deleteOwnAccount(
    userId: string,
    confirmationWord: string,
    currentPassword: string,
    currentRawRefreshToken?: string | null,
  ) {
    if (String(confirmationWord).trim().toUpperCase() !== 'DELETE') {
      throw new BadRequestException('Type DELETE to confirm account deletion');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        username: true,
        password: true,
        passwordCredentialStatus: true,
      },
    });
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!this.hasLocalPassword(user)) {
      throw new BadRequestException(
        'Set a password before deleting your account',
      );
    }

    const passwordValid = await this.verifyOptionalPassword(
      user.password,
      currentPassword,
    );
    if (!passwordValid) {
      throw new UnauthorizedException('Incorrect password');
    }

    const deletedAt = new Date();
    const suffix = deletedAt.getTime().toString(36);
    const deletedEmail = `deleted+${suffix}-${user.id}@weaz.local`;
    const deletedUsername = `deleted_${suffix}`;
    const placeholderPassword = await this.passwordService.hashPassword(
      randomBytes(32).toString('hex'),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.user.update({
        where: { id: userId },
        data: {
          email: deletedEmail,
          username: deletedUsername,
          password: placeholderPassword,
          passwordCredentialStatus: PasswordCredentialStatus.DISABLED,
          status: UserStatus.DEACTIVATED,
          deactivatedAt: deletedAt,
          deactivatedReason: 'USER_SELF_DELETE',
          pendingEmail: null,
          pendingEmailTokenHash: null,
          pendingEmailExpiresAt: null,
          authVersion: { increment: 1 },
        },
      } as any);
    });

    await this.tokenService.revokeRefreshToken(currentRawRefreshToken);

    return { message: 'Your account has been deleted.' };
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
    const resetLink = buildAdminPasswordResetLink(rawTokenToSend);
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
            passwordCredentialStatus: true,
            email: true,
            username: true,
            userProfile: { select: canonicalUserProfileSelect },
            brand: { select: { name: true } },
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
        brandFullName: resolveRequiredBrandField(
          resetToken.user,
          'brandFullName',
        ),
        firstName: resolveRequiredProfileField(resetToken.user, 'firstName'),
        lastName: resolveRequiredProfileField(resetToken.user, 'lastName'),
      }),
    );

    const isSamePassword = await this.verifyOptionalPassword(
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

        await tx.refreshToken.deleteMany({
          where: { userId: resetToken.userId },
        });

        await tx.user.update({
          where: { id: resetToken.userId },
          data: {
            password,
            passwordCredentialStatus: PasswordCredentialStatus.ENABLED,
            mustResetPassword: false,
            authVersion: { increment: 1 },
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    const passwordChangedEmail =
      emailTemplates.passwordChangedSecurityAlertEmail(
        this.emailService.getAppName(),
      );
    await this.sendScenarioEmailIfAllowed({
      userId: resetToken.userId,
      to: resetToken.user.email,
      scenarioKey: 'auth.password.changed',
      subject: passwordChangedEmail.subject,
      html: passwordChangedEmail.html,
      text: passwordChangedEmail.text,
      priority: EmailPriority.P0_SECURITY,
      idempotencyKey: `auth:admin-password-reset-confirmed:${resetToken.userId}:${resetToken.id}`,
    });

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
      select: {
        id: true,
        status: true,
        password: true,
        passwordCredentialStatus: true,
      },
    });

    // Always return generic response to prevent email enumeration
    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      !this.hasLocalPassword(user)
    ) {
      this.logger.log(
        `Password reset requested for unknown, inactive, or passwordless account ${maskEmailForLog(normalizedEmail)}`,
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
    const resetLink = buildPasswordResetLink(rawTokenToSend);
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
            passwordCredentialStatus: true,
            email: true,
            username: true,
            userProfile: { select: canonicalUserProfileSelect },
            brand: { select: { name: true } },
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
        brandFullName: resolveRequiredBrandField(
          resetToken.user,
          'brandFullName',
        ),
        firstName: resolveRequiredProfileField(resetToken.user, 'firstName'),
        lastName: resolveRequiredProfileField(resetToken.user, 'lastName'),
      }),
    );

    const isSamePassword = await this.verifyOptionalPassword(
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

        await tx.refreshToken.deleteMany({
          where: { userId: resetToken.userId },
        });

        await tx.user.update({
          where: { id: resetToken.userId },
          data: {
            password,
            passwordCredentialStatus: PasswordCredentialStatus.ENABLED,
            authVersion: { increment: 1 },
          },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );

    const passwordChangedEmail =
      emailTemplates.passwordChangedSecurityAlertEmail(
        this.emailService.getAppName(),
      );
    await this.sendScenarioEmailIfAllowed({
      userId: resetToken.userId,
      to: resetToken.user.email,
      scenarioKey: 'auth.password.changed',
      subject: passwordChangedEmail.subject,
      html: passwordChangedEmail.html,
      text: passwordChangedEmail.text,
      priority: EmailPriority.P0_SECURITY,
      idempotencyKey: `auth:password-reset-confirmed:${resetToken.userId}:${resetToken.id}`,
    });

    this.logger.log(`Password reset confirmed for user ${resetToken.userId}`);

    return { message: 'Password reset successful' };
  }

  async changePasswordForAuthenticatedUser(
    userId: string,
    currentPassword: string | undefined,
    newPassword: string,
    currentRawRefreshToken?: string | null,
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
        userProfile: { select: canonicalUserProfileSelect },
        brand: { select: { name: true } },
        password: true,
        passwordCredentialStatus: true,
        mustResetPassword: true,
      },
    });
    if (!user) throw new UnauthorizedException('User not found');

    if (!this.hasLocalPassword(user)) {
      throw new BadRequestException(
        'Use the password setup flow before changing your password',
      );
    }

    // If not in forced-reset mode, verify current password.
    if (!user.mustResetPassword) {
      if (!currentPassword) {
        throw new BadRequestException('Current password is required');
      }

      const valid = await this.verifyOptionalPassword(
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
        brandFullName: resolveRequiredBrandField(user, 'brandFullName'),
        firstName: resolveRequiredProfileField(user, 'firstName'),
        lastName: resolveRequiredProfileField(user, 'lastName'),
      }),
    );

    const isSamePassword = await this.verifyOptionalPassword(
      user.password,
      newPassword,
    );
    if (isSamePassword) {
      throw new BadRequestException(
        'New password must be different from your current password',
      );
    }

    const password = await this.passwordService.hashPassword(newPassword);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        password,
        passwordCredentialStatus: PasswordCredentialStatus.ENABLED,
        mustResetPassword: false,
        authVersion: { increment: 1 },
      },
    });
    await this.tokenService.revokeOtherRefreshTokens(
      userId,
      currentRawRefreshToken,
    );

    const passwordChangedEmail =
      emailTemplates.passwordChangedSecurityAlertEmail(
        this.emailService.getAppName(),
      );
    await this.sendScenarioEmailIfAllowed({
      userId,
      to: user.email,
      scenarioKey: 'auth.password.changed',
      subject: passwordChangedEmail.subject,
      html: passwordChangedEmail.html,
      text: passwordChangedEmail.text,
      priority: EmailPriority.P0_SECURITY,
      idempotencyKey: `auth:password-changed:${userId}:${Date.now()}`,
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
      throw new BadRequestException(
        'Email, current password, and new password are required',
      );
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'New password must be different from temporary password',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: {
        id: true,
        role: true,
        password: true,
        passwordCredentialStatus: true,
        mustResetPassword: true,
        email: true,
        username: true,
        userProfile: { select: canonicalUserProfileSelect },
        brand: { select: { name: true } },
      },
    });

    if (!user || (user.role !== Role.Admin && user.role !== Role.SuperAdmin)) {
      throw new UnauthorizedException('Invalid account or credentials');
    }
    if (!user.mustResetPassword) {
      throw new BadRequestException(
        'This account does not require a password reset',
      );
    }

    if (!this.hasLocalPassword(user)) {
      throw new UnauthorizedException('Invalid account or credentials');
    }

    const valid = await this.verifyOptionalPassword(
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
        brandFullName: resolveRequiredBrandField(user, 'brandFullName'),
        firstName: resolveRequiredProfileField(user, 'firstName'),
        lastName: resolveRequiredProfileField(user, 'lastName'),
      }),
    );

    const isSamePassword = await this.verifyOptionalPassword(
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
          passwordCredentialStatus: PasswordCredentialStatus.ENABLED,
          mustResetPassword: false,
          authVersion: { increment: 1 },
        },
      });
    });

    return { message: 'Password reset complete. You can now sign in.' };
  }
}
