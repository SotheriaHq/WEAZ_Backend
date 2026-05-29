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
import { RequestEmailChangeDto } from './dto/request-email-change.dto';
import { ConfirmEmailChangeDto } from './dto/confirm-email-change.dto';
import { DeleteAccountDto } from './dto/delete-account.dto';
import {
  CreateStudioHandoffDto,
  ExchangeStudioHandoffDto,
} from './dto/studio-handoff.dto';
import { StudioHandoffService } from './studio-handoff.service';
import {
  ConfirmEmailLoginCodeDto,
  GoogleAuthDto,
  LoginOptionsDto,
  PasswordSetupDto,
  RequestEmailLoginCodeDto,
} from './dto/google-auth.dto';

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
    private readonly studioHandoff: StudioHandoffService,
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

  @Post('google')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign up or log in with a Google ID token' })
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @UseInterceptors(TransformInterceptor)
  async googleAuth(
    @Body(ValidationPipe) body: GoogleAuthDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.authService.googleAuth(body, req, res);
  }

  @Post('login-options')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resolve safe sign-in method options after email Continue',
  })
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  async loginOptions(@Body(ValidationPipe) body: LoginOptionsDto) {
    return this.authService.getLoginOptions(body.email);
  }

  @Post('email-login-code/request')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Request an email code for Google-only password setup',
  })
  @Throttle({ default: { limit: 3, ttl: 900000 } })
  async requestEmailLoginCode(
    @Body(ValidationPipe) body: RequestEmailLoginCodeDto,
  ) {
    return this.authService.requestEmailLoginCode(body.email, body.purpose);
  }

  @Post('email-login-code/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirm an email code for Google-only password setup',
  })
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  async confirmEmailLoginCode(
    @Body(ValidationPipe) body: ConfirmEmailLoginCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.authService.confirmEmailLoginCode(
      body.email,
      body.code,
      body.purpose,
      req,
      res,
    );
  }

  @Post('password/setup')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Set the first local password after email-code verification',
  })
  @Throttle({ default: { limit: 5, ttl: 900000 } })
  async setupPassword(@Body(ValidationPipe) body: PasswordSetupDto) {
    return this.authService.setupPassword(
      body.passwordSetupToken,
      body.newPassword,
    );
  }

  @Post('google/link')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Link Google sign-in to the authenticated account' })
  @Throttle({ default: { limit: 4, ttl: 900000 } })
  async linkGoogle(
    @Req() req: Request & { user: { id: string } },
    @Body(ValidationPipe) body: GoogleAuthDto,
  ) {
    return this.authService.linkGoogle(req.user.id, body.idToken);
  }

  @Post('account-reactivation/request')
  @ApiOperation({
    summary:
      'Submit account reactivation/leniency request for suspended or deactivated users',
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
  @ApiOperation({
    summary: 'Complete first-login required admin password reset',
  })
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
  @ApiOperation({
    summary: 'Confirm password reset with token for regular users',
  })
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
    const refreshToken = req.cookies[this.refreshTokenCookieName];
    return this.authService.changePasswordForAuthenticatedUser(
      req.user.id,
      body.currentPassword,
      body.newPassword,
      refreshToken,
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
    const refreshToken = req.cookies[this.refreshTokenCookieName];
    return this.authService.changePasswordForAuthenticatedUser(
      req.user.id,
      body.currentPassword,
      body.newPassword,
      refreshToken,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 4, ttl: 900000 } })
  @Post('change-email/request')
  @ApiOperation({ summary: 'Request authenticated email change confirmation' })
  async requestEmailChange(
    @Req() req: Request & { user: { id: string } },
    @Body(ValidationPipe) body: RequestEmailChangeDto,
  ) {
    return this.authService.requestEmailChange(
      req.user.id,
      body.newEmail,
      body.currentPassword,
    );
  }

  @Post('change-email/confirm')
  @Throttle({ default: { limit: 8, ttl: 900000 } })
  @ApiOperation({ summary: 'Confirm pending authenticated email change' })
  async confirmEmailChange(@Body(ValidationPipe) body: ConfirmEmailChangeDto) {
    return this.authService.confirmEmailChange(body.token);
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

  @Post('studio-handoff')
  @UseGuards(JwtAuthGuard)
  @HttpCode(201)
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  @ApiOperation({
    summary: 'Create a short-lived mobile-to-web Studio handoff code',
  })
  @UseInterceptors(TransformInterceptor)
  async createStudioHandoff(
    @Req() req: Request & { user: { id: string; type?: string | null } },
    @Body(ValidationPipe) body: CreateStudioHandoffDto,
  ) {
    return this.studioHandoff.create(req.user, body.intendedPath, req);
  }

  @Post('studio-handoff/exchange')
  @HttpCode(200)
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  @ApiOperation({
    summary: 'Exchange a Studio handoff code for a normal web session',
  })
  @UseInterceptors(TransformInterceptor)
  async exchangeStudioHandoff(
    @Req() req: Request,
    @Body(ValidationPipe) body: ExchangeStudioHandoffDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.studioHandoff.exchange(body.code, req, res);
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
  @ApiOperation({
    summary: 'Resend email verification link for authenticated user',
  })
  async resendEmailVerification(
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.authService.resendVerificationEmail(req.user.id);
  }

  @Get('security/devices')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'List recognized and trusted devices for the authenticated user',
  })
  async listSecurityDevices(@Req() req: Request & { user: { id: string } }) {
    return this.authService.getTrustedDevices(req.user.id);
  }

  @Patch('security/devices/:id/revoke')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Revoke a recognized device for the authenticated user',
  })
  async revokeSecurityDevice(
    @Req() req: Request & { user: { id: string } },
    @Param('id') id: string,
  ) {
    return this.authService.revokeTrustedDevice(req.user.id, id);
  }

  @Get('security/sessions')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'List recent login sessions for the authenticated user',
  })
  async listSecuritySessions(@Req() req: Request & { user: { id: string } }) {
    const refreshToken = req.cookies[this.refreshTokenCookieName];
    return this.authService.listSecuritySessions(req.user.id, refreshToken);
  }

  @Patch('security/sessions/:id/revoke')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Revoke a login session for the authenticated user',
  })
  async revokeSecuritySession(
    @Req() req: Request & { user: { id: string } },
    @Param('id') id: string,
  ) {
    const refreshToken = req.cookies[this.refreshTokenCookieName];
    return this.authService.revokeSecuritySession(
      req.user.id,
      id,
      refreshToken,
    );
  }

  @Post('security/sessions/logout-others')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary:
      'Revoke all other login sessions while preserving the current session',
  })
  async logoutOtherSessions(@Req() req: Request & { user: { id: string } }) {
    const refreshToken = req.cookies[this.refreshTokenCookieName];
    return this.authService.logoutOtherSessions(req.user.id, refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 2, ttl: 900000 } })
  @Post('account/delete')
  @ApiOperation({ summary: 'Permanently delete the authenticated account' })
  async deleteAccount(
    @Req() req: Request & { user: { id: string } },
    @Body(ValidationPipe) body: DeleteAccountDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies[this.refreshTokenCookieName];
    const result = await this.authService.deleteOwnAccount(
      req.user.id,
      body.confirmationWord,
      body.currentPassword,
      refreshToken,
    );

    const cookieOptions = this.cookieBaseOptions;
    res.clearCookie(this.refreshTokenCookieName, cookieOptions);
    res.clearCookie(this.accessTokenCookieName, cookieOptions);
    return result;
  }
}
