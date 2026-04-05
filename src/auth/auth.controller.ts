import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  UseInterceptors,
  ValidationPipe,
  Req,
  Res,
  HttpCode,
  UnauthorizedException,
  UseGuards,
  Query,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { CreateUserDto } from './dto/create-auth.dto';
import { TransformInterceptor } from 'src/transform/transform.interceptor';
import { TokenService } from './helper/general.helper';
import { LoginDto } from './dto/login-auth.dto';
import { JwtAuthGuard } from './guard/jwt-auth.guard';
import { RolesGuard } from './guard/role.guard';
import { Roles } from './decorator/roles.decorator';
import { Role, NotificationType } from '@prisma/client';
import { Throttle, ThrottlerGuard, SkipThrottle } from '@nestjs/throttler';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from 'src/notifications/notifications.service';
import { RequestAccountReactivationDto } from './dto/request-account-reactivation.dto';
import { RequestAdminPasswordResetDto } from './dto/request-admin-password-reset.dto';
import { ConfirmAdminPasswordResetDto } from './dto/confirm-admin-password-reset.dto';
import { ChangeAuthenticatedPasswordDto } from './dto/change-authenticated-password.dto';
import { CompleteAdminFirstLoginResetDto } from './dto/complete-admin-first-login-reset.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { ConfirmPasswordResetDto } from './dto/confirm-password-reset.dto';

@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
    private readonly configService: ConfigService,
    private readonly notifications: NotificationsService,
  ) {}

  private get accessTokenCookieName(): string {
    return this.configService.get<string>('ACCESS_TOKEN_COOKIE', 'accessToken');
  }

  private get refreshTokenCookieName(): string {
    return this.configService.get<string>(
      'REFRESH_TOKEN_COOKIE',
      'refreshToken',
    );
  }

  private get cookieBaseOptions() {
    return {
      httpOnly: true,
      secure:
        this.configService.get<string>('NODE_ENV', '').toLowerCase() ===
        'production',
      sameSite: 'strict' as const,
      path: '/',
    };
  }

  private extractClientIp(req: Request): string | null {
    return req.ip || req.socket?.remoteAddress || null;
  }

  @Post('login')
  @ApiOperation({ summary: 'User login' })
  @ApiBody({ type: LoginDto })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseInterceptors(TransformInterceptor)
  async login(
    @Body(ValidationPipe) loginDto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.authService.login(loginDto, req, res);
  }

  @Post('signup')
  @ApiOperation({ summary: 'User signup' })
  @ApiBody({ type: CreateUserDto })
  @ApiResponse({ status: 201, description: 'Signup successful' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @UseInterceptors(TransformInterceptor)
  async create(
    @Body(ValidationPipe) dto: CreateUserDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.authService.CreateUser(dto, req, res);
  }

  @Post('account-reactivation/request')
  @ApiOperation({
    summary: 'Submit account reactivation/leniency request for suspended or deactivated users',
  })
  @Throttle({ default: { limit: 3, ttl: 300000 } })
  async requestAccountReactivation(
    @Body(ValidationPipe) body: RequestAccountReactivationDto,
  ) {
    return this.authService.requestAccountReactivation(body.email, body.reason);
  }

  @Post('admin/reset-password/request')
  @ApiOperation({ summary: 'Request admin reset password token' })
  @Throttle({ default: { limit: 3, ttl: 900000 } })
  async requestAdminResetPassword(
    @Body(ValidationPipe) body: RequestAdminPasswordResetDto,
  ) {
    return this.authService.requestAdminPasswordReset(body.email);
  }

  @Post('admin/reset-password/confirm')
  @ApiOperation({ summary: 'Confirm admin reset password with token' })
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  async confirmAdminResetPassword(
    @Body(ValidationPipe) body: ConfirmAdminPasswordResetDto,
  ) {
    return this.authService.resetAdminPassword(body.token, body.newPassword);
  }

  @Post('admin/reset-password/first-login')
  @ApiOperation({ summary: 'Complete first-login required admin password reset' })
  @Throttle({ default: { limit: 6, ttl: 900000 } })
  async completeAdminFirstLoginReset(
    @Body(ValidationPipe) body: CompleteAdminFirstLoginResetDto,
  ) {
    return this.authService.completeAdminFirstLoginReset(
      body.email,
      body.currentPassword,
      body.newPassword,
    );
  }

  @Post('password-reset/request')
  @ApiOperation({ summary: 'Request password reset token for regular users' })
  @Throttle({ default: { limit: 3, ttl: 900000 } })
  async requestPasswordReset(
    @Body(ValidationPipe) body: RequestPasswordResetDto,
  ) {
    return this.authService.requestPasswordReset(body.email);
  }

  @Post('password-reset/confirm')
  @ApiOperation({ summary: 'Confirm password reset with token for regular users' })
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  async confirmPasswordReset(
    @Body(ValidationPipe) body: ConfirmPasswordResetDto,
  ) {
    return this.authService.confirmPasswordReset(body.token, body.newPassword);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 6, ttl: 900000 } })
  @Post('admin/change-password')
  @ApiOperation({ summary: 'Change password for authenticated admin/user' })
  async changeAuthenticatedPassword(
    @Req() req: Request & { user: { id: string } },
    @Body(ValidationPipe) body: ChangeAuthenticatedPasswordDto,
  ) {
    return this.authService.changePasswordForAuthenticatedUser(
      req.user.id,
      body.currentPassword,
      body.newPassword,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 6, ttl: 900000 } })
  @Post('change-password')
  @ApiOperation({ summary: 'Change password for authenticated user' })
  async changeAuthenticatedPasswordAlias(
    @Req() req: Request & { user: { id: string } },
    @Body(ValidationPipe) body: ChangeAuthenticatedPasswordDto,
  ) {
    return this.authService.changePasswordForAuthenticatedUser(
      req.user.id,
      body.currentPassword,
      body.newPassword,
    );
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed' })
  @ApiResponse({
    status: 401,
    description: 'Refresh token not found or invalid',
  })
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } }) // 10 refresh attempts per minute
  @UseInterceptors(TransformInterceptor)
  async refresh(
    @Req() req: Request,
    @Body('refreshToken') bodyRefreshToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken =
      req.cookies[this.refreshTokenCookieName] ?? bodyRefreshToken;
    if (!refreshToken) {
      const cookieOptions = this.cookieBaseOptions;
      res.clearCookie(this.refreshTokenCookieName, cookieOptions);
      res.clearCookie(this.accessTokenCookieName, cookieOptions);
      throw new UnauthorizedException('Refresh token not found');
    }

    try {
      return await this.tokenService.refreshToken(refreshToken, req, res);
    } catch (error) {
      const cookieOptions = this.cookieBaseOptions;
      res.clearCookie(this.refreshTokenCookieName, cookieOptions);
      res.clearCookie(this.accessTokenCookieName, cookieOptions);
      throw error;
    }
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Logout user' })
  @ApiResponse({ status: 200, description: 'Logout successful' })
  async logout(
    @Req() req: Request & { user: { id: string } },
    @Body('refreshToken') bodyRefreshToken: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken =
      req.cookies[this.refreshTokenCookieName] ?? bodyRefreshToken;

    const cookieOptions = this.cookieBaseOptions;

    res.clearCookie(this.refreshTokenCookieName, cookieOptions);
    res.clearCookie(this.accessTokenCookieName, cookieOptions);

    await this.tokenService.revokeRefreshToken(refreshToken);

    // Emit logout activity without blocking API response.
    const ipAddress = this.extractClientIp(req);
    void this.notifications
      .create(req.user.id, NotificationType.LOGOUT, {
        payload: {
          ip: ipAddress,
          userAgent: req.headers['user-agent'] ?? null,
        },
      })
      .catch(() => undefined);

    return { message: 'Logged out successfully' };
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Logout user from all devices' })
  @ApiResponse({ status: 200, description: 'All refresh tokens revoked' })
  async logoutAll(
    @Req() req: Request & { user: { id: string } },
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookieOptions = this.cookieBaseOptions;

    res.clearCookie(this.refreshTokenCookieName, cookieOptions);
    res.clearCookie(this.accessTokenCookieName, cookieOptions);

    await this.tokenService.revokeAllRefreshTokens(req.user.id);

    const ipAddress = this.extractClientIp(req);
    void this.notifications
      .create(req.user.id, NotificationType.LOGOUT_ALL, {
        payload: {
          ip: ipAddress,
          userAgent: req.headers['user-agent'] ?? null,
        },
      })
      .catch(() => undefined);

    return { message: 'Logged out from all devices' };
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @SkipThrottle()
  @UseInterceptors(TransformInterceptor)
  async getProfile(@Req() req: Request & { user: { id: string } }) {
    return this.authService.getProfileWithImage(req.user.id);
  }

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin, Role.User)
  @Patch('update-profile/:id')
  @ApiOperation({ summary: 'Update user profile (except password)' })
  @ApiParam({ name: 'id', required: true })
  @ApiBody({ type: UpdateProfileDto })
  @ApiResponse({ status: 200, description: 'Profile updated' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseInterceptors(TransformInterceptor)
  async updateProfile(
    @Param('id') id: string,
    @Body(ValidationPipe) dto: UpdateProfileDto,
    @Req() req: Request & { user: { id: string; role: Role } },
  ) {
    // Only allow if requester is the user or SuperAdmin
    if (req.user.id !== id && req.user.role !== Role.SuperAdmin) {
      throw new UnauthorizedException('Not allowed to update this profile');
    }
    return this.authService.updateProfile(id, dto);
  }

  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email by link' })
  @ApiQuery({ name: 'token', required: false })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'code', required: false })
  async verifyEmailByLink(
    @Query('token') token?: string,
    @Query('userId') userId?: string,
    @Query('code') code?: string,
  ) {
    if (token) {
      return this.authService.verifyEmailByToken(token);
    }

    if (userId && code) {
      return this.authService.verifyEmailByLink(userId, code);
    }

    throw new BadRequestException(
      'Verification token is required. Use the verification link sent to your email.',
    );
  }

  @Post('verify-email-code')
  @ApiOperation({ summary: 'Verify email by code' })
  @ApiBody({
    schema: {
      properties: { email: { type: 'string' }, code: { type: 'string' } },
    },
  })
  async verifyEmailByCode(
    @Body('email') email: string,
    @Body('code') code: string,
  ) {
    return this.authService.verifyEmailByCode(email, code);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 3, ttl: 300000 } })
  @Post('verify-email/resend')
  @ApiOperation({ summary: 'Resend email verification link for authenticated user' })
  async resendEmailVerification(
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.authService.resendVerificationEmail(req.user.id);
  }

  @Get('security/devices')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List recognized and trusted devices for the authenticated user' })
  async listSecurityDevices(@Req() req: Request & { user: { id: string } }) {
    return this.authService.getTrustedDevices(req.user.id);
  }

  @Patch('security/devices/:id/revoke')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Revoke a recognized device for the authenticated user' })
  async revokeSecurityDevice(
    @Req() req: Request & { user: { id: string } },
    @Param('id') id: string,
  ) {
    return this.authService.revokeTrustedDevice(req.user.id, id);
  }

}
