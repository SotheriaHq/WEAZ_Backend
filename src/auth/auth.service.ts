import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-auth.dto';
import { UpdateAuthDto } from './dto/update-auth.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { PasswordService } from 'src/auth/helper/password.service';
import { LoginDto } from './dto/login-auth.dto';
import { v4 as uuidv4 } from 'uuid';
import { UserType, Role, NotificationType } from '@prisma/client';
import {
  authUserSelect,
  profileUserSelect,
  toAuthUserResponse,
  toAuthUsersResponse,
  AuthUser,
} from 'src/auth/helper/prisma-select.helper';
import { TokenService } from './helper/general.helper';
import { Request, Response } from 'express';
import { UserHelperService } from './helper/user-helper.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { NotificationsService } from 'src/notifications/notifications.service';
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';
import { createHash, randomBytes } from 'crypto';
import { DEFAULT_ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';

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
  ) { }

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

      // TODO: Prepare and send verification link to the user's email
      // const verificationLink = this.emailVerificationHelper.generateVerificationLink(
      //   user.id,
      //   verificationCode,
      // );
      // TODO: Send email to user.email with verificationLink and verificationCode

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
      const forwarded = req.headers['x-forwarded-for'];
      const ip = Array.isArray(forwarded)
        ? (forwarded[0] ?? null)
        : typeof forwarded === 'string' && forwarded.length
          ? forwarded.split(',')[0].trim()
          : null;
      const ipAddress = ip || req.ip || null;
      void this.notifications
        .create(user.id, NotificationType.LOGIN, {
          payload: {
            ip: ipAddress,
            userAgent: req.headers['user-agent'] ?? null,
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

  // Validates user credentials for login
  async validateUser(email: string, password: string) {
    // Normalize email: trim whitespace and convert to lowercase for case-insensitive matching
    const normalizedEmail = email?.trim().toLowerCase();

    try {
      const user = await this.prisma.user
        .findFirst({
          where: {
            email: normalizedEmail,
            isActive: { not: 'Inactive' },
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

      return publicUser as AuthUser;
    } catch (error) {
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

  async updateUserRole(userId: string, role: Role) {
    try {
      const target = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true, status: true },
      });
      if (!target) {
        throw new BadRequestException('User not found');
      }

      if (target.role === Role.SuperAdmin && role !== Role.SuperAdmin) {
        const activeSuperAdmins = await this.prisma.user.count({
          where: { role: Role.SuperAdmin, status: 'ACTIVE' },
        });
        if (activeSuperAdmins <= 1) {
          throw new BadRequestException('Cannot demote the last active SuperAdmin');
        }
      }

      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: { role },
        select: authUserSelect,
      });

      if (target.role !== Role.Admin && role === Role.Admin) {
        await this.prisma.adminPermissionGrant.createMany({
          data: DEFAULT_ADMIN_PERMISSIONS.map((permissionCode) => ({
            id: uuidv4(),
            userId,
            permissionCode,
            grantedById: userId,
          })),
          skipDuplicates: true,
        });
      }

      if (target.role === Role.Admin && role !== Role.Admin) {
        await this.prisma.adminPermissionGrant.deleteMany({ where: { userId } });
      }

      await this.tokenService.revokeAllRefreshTokens(userId);
      return toAuthUserResponse(updatedUser);
    } catch (error) {
      this.logger.error('Role update error:', error);
      throw new BadRequestException('Failed to update user role');
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

  // Get all users
  async getAllUsers() {
    const users = await this.prisma.user.findMany({ select: authUserSelect });
    return toAuthUsersResponse(users);
  }

  // Get single user
  async getUserById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: authUserSelect,
    });
    if (!user) throw new BadRequestException('User not found');
    return toAuthUserResponse(user);
  }

  // Update user (not profile)
  async updateUser(userId: string, dto: UpdateAuthDto) {
    if ((dto as any).password !== undefined || (dto as any).role !== undefined) {
      throw new BadRequestException(
        'Password and role must be updated via dedicated endpoints',
      );
    }
    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
      select: authUserSelect,
    });
    return toAuthUserResponse(updatedUser);
  }

  // Soft delete user (set isActive to 'Inactive')
  async softDeleteUser(userId: string) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: {
        isActive: 'Inactive',
        status: 'DEACTIVATED',
        deactivatedAt: new Date(),
        deactivatedReason: 'Deactivated via deprecated /auth/user/:id endpoint',
      },
      select: authUserSelect,
    });
    await this.tokenService.revokeAllRefreshTokens(userId);
    return {
      message: 'User account deactivated',
      user: toAuthUserResponse(user),
    };
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

  async requestAdminPasswordReset(email: string) {
    const normalizedEmail = email?.trim().toLowerCase();
    if (!normalizedEmail) {
      throw new BadRequestException('Email is required');
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, role: true },
    });

    if (!user || (user.role !== Role.Admin && user.role !== Role.SuperAdmin)) {
      // Return generic success response to prevent account enumeration
      return { message: 'If the account exists, a reset link has been generated.' };
    }

    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await this.prisma.passwordResetToken.create({
      data: {
        id: uuidv4(),
        userId: user.id,
        tokenHash,
        expiresAt,
      },
    });

    // In production this should be emailed; for now return token for integration.
    return {
      message: 'Password reset token generated',
      resetToken: rawToken,
      expiresAt,
    };
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

    const password = await this.passwordService.hashPassword(newPassword);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: resetToken.userId },
        data: {
          password,
          mustResetPassword: false,
        },
      });

      await tx.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      });
    });

    await this.tokenService.revokeAllRefreshTokens(resetToken.userId);

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
      select: { id: true, password: true, mustResetPassword: true },
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

    const password = await this.passwordService.hashPassword(newPassword);

    await this.prisma.user.update({
      where: { id: userId },
      data: { password, mustResetPassword: false },
    });

    await this.tokenService.revokeAllRefreshTokens(userId);

    return { message: 'Password updated successfully' };
  }
}
