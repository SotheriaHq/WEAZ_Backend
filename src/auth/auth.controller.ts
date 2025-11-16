import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
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
import { UpdateAuthDto } from './dto/update-auth.dto';
import { TransformInterceptor } from 'src/transform/transform.interceptor';
import { TokenService } from './helper/general.helper';
import { LoginDto } from './dto/login-auth.dto';
import { JwtAuthGuard } from './guard/jwt-auth.guard';
import { RolesGuard } from './guard/role.guard';
import { Roles } from './decorator/roles.decorator';
import { Role } from '@prisma/client';
import { Throttle, ThrottlerGuard, SkipThrottle } from '@nestjs/throttler';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from 'src/notifications/notifications.service';

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
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies[this.refreshTokenCookieName];
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token not found');
    }

    return this.tokenService.refreshToken(refreshToken, req, res);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  @ApiOperation({ summary: 'Logout user' })
  @ApiResponse({ status: 200, description: 'Logout successful' })
  async logout(
    @Req() req: Request & { user: { id: string } },
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshToken = req.cookies[this.refreshTokenCookieName];

    const cookieOptions = this.cookieBaseOptions;

    res.clearCookie(this.refreshTokenCookieName, cookieOptions);
    res.clearCookie(this.accessTokenCookieName, cookieOptions);

    await this.tokenService.revokeRefreshToken(refreshToken);

    // Create logout notification (requires enum migration). Use string to avoid type friction.
    try {
      const forwarded = req.headers['x-forwarded-for'];
      const ip = Array.isArray(forwarded)
        ? (forwarded[0] ?? null)
        : typeof forwarded === 'string' && forwarded.length
          ? forwarded.split(',')[0].trim()
          : null;
      const ipAddress = ip || req.ip || null;
      await this.notifications.create(req.user.id, 'LOGOUT' as any, {
        payload: {
          ip: ipAddress,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    } catch {}

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

    try {
      const forwarded = req.headers['x-forwarded-for'];
      const ip = Array.isArray(forwarded)
        ? (forwarded[0] ?? null)
        : typeof forwarded === 'string' && forwarded.length
          ? forwarded.split(',')[0].trim()
          : null;
      const ipAddress = ip || req.ip || null;
      await this.notifications.create(req.user.id, 'LOGOUT_ALL' as any, {
        payload: {
          ip: ipAddress,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    } catch {}

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

  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @Patch('update-role/:id')
  @ApiOperation({ summary: 'Update user role (SuperAdmin only)' })
  @ApiParam({ name: 'id', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['SuperAdmin', 'Admin', 'User'] },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Role updated' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @UseInterceptors(TransformInterceptor)
  async updateUserRole(@Param('id') id: string, @Body('role') role: Role) {
    // Only SuperAdmin can access
    return this.authService.updateUserRole(id, role);
  }

  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email by link' })
  @ApiParam({ name: 'userId', required: true })
  @ApiParam({ name: 'code', required: true })
  async verifyEmailByLink(
    @Query('userId') userId: string,
    @Query('code') code: string,
  ) {
    return this.authService.verifyEmailByLink(userId, code);
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

  @Get('users')
  @ApiOperation({ summary: 'Get all users' })
  async getAllUsers() {
    return this.authService.getAllUsers();
  }

  @Get('user/:id')
  @ApiOperation({ summary: 'Get single user' })
  @ApiParam({ name: 'id', required: true })
  async getUserById(@Param('id') id: string) {
    return this.authService.getUserById(id);
  }

  @Patch('user/:id')
  @ApiOperation({ summary: 'Update user (not profile)' })
  @ApiParam({ name: 'id', required: true })
  @ApiBody({ type: UpdateAuthDto })
  async updateUser(
    @Param('id') id: string,
    @Body(ValidationPipe) dto: UpdateAuthDto,
  ) {
    return this.authService.updateUser(id, dto);
  }

  @Delete('user/:id')
  @ApiOperation({ summary: 'Soft delete user (set isActive to Inactive)' })
  @ApiParam({ name: 'id', required: true })
  async softDeleteUser(@Param('id') id: string) {
    return this.authService.softDeleteUser(id);
  }
}
