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
import { UserType, Role } from '@prisma/client';
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
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordService: PasswordService,
    private readonly tokenService: TokenService,
    private readonly userHelperService: UserHelperService,
    private readonly emailVerificationHelper: EmailVerificationHelperService,
  ) {}

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
    const { email } = signupDto;

    try {
      const existingUser = await this.prisma.user
        .findUnique({
          where: { email },
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
            role: signupDto.role ?? Role.User,
            firstName: dbFirstName,
            lastName: dbLastName,
            email: signupDto.email,
            password: hashedPassword,
            brandFullName: signupDto.brandFullName,
            type: signupDto.type ?? UserType.REGULAR,
            industriNumber,
            emailVerificationCode: verificationCode,
            isEmailVerified: false,
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
      try {
        const tokenResult = await this.tokenService.generateTokens(
          user,
          req,
          res,
        );
        accessToken = tokenResult.accessToken;
      } catch (tokenError) {
        this.logger.error('Token generation failed:', tokenError);
        // User was created but token failed - still return success
        // The user can login later
        return {
          user: toAuthUserResponse(user),
          accessToken: null,
          message:
            'Account created successfully, please login to get access token',
        };
      }

      return {
        user: toAuthUserResponse(user),
        accessToken,
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
      try {
        const tokenResult = await this.tokenService.generateTokens(
          user,
          req,
          res,
        );
        accessToken = tokenResult.accessToken;
      } catch (tokenError) {
        this.logger.error('Token generation failed during login:', tokenError);
        throw new UnauthorizedException(
          'Login failed - token generation error',
        );
      }

      return {
        user: toAuthUserResponse(user),
        accessToken,
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
    try {
      const user = await this.prisma.user
        .findFirst({
          where: { email },
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
      const updatedUser = await this.prisma.user.update({
        where: { id: userId },
        data: { role },
        select: authUserSelect,
      });
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
      data: { isActive: 'Inactive' },
      select: authUserSelect,
    });
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
}
