import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Param,
  UseGuards,
  Req,
  UnauthorizedException,
  ValidationPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserProfileService } from './user-profile.service';
import { UpdateProfileVisibilityDto } from './dto/update-profile-visibility.dto';
import { OptionalJwtAuthGuard } from '../auth/guard/optional-jwt-auth.guard';
import { UpdateUserPreferencesDto } from './dto/update-user-preferences.dto';
import { UpdateProfileDto } from '../auth/dto/update-profile.dto';

@Controller('users')
export class UserProfileController {
  constructor(private readonly userProfileService: UserProfileService) {}

  private getAuthUserId(req: any): string {
    const userId = req?.user?.id ?? req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }
    return userId;
  }

  @Get('me/profile')
  @UseGuards(AuthGuard('jwt'))
  async getOwnProfile(@Req() req) {
    return this.userProfileService.getOwnProfile(this.getAuthUserId(req));
  }

  @Patch('me/profile')
  @UseGuards(AuthGuard('jwt'))
  async updateOwnProfile(
    @Req() req,
    @Body(ValidationPipe) updateProfileDto: UpdateProfileDto,
  ) {
    return this.userProfileService.updateOwnProfile(
      this.getAuthUserId(req),
      updateProfileDto,
    );
  }

  @Get(':id/profile')
  @UseGuards(AuthGuard('jwt'))
  async getPublicProfile(@Param('id') userId: string, @Req() req) {
    return this.userProfileService.getPublicProfile(
      userId,
      this.getAuthUserId(req),
    );
  }

  @Get(':id/profile/public')
  @UseGuards(OptionalJwtAuthGuard)
  async getPublicProfileAnonymous(@Param('id') userId: string, @Req() req) {
    const viewerId = req?.user?.id ?? req?.user?.sub;
    return this.userProfileService.getPublicProfile(userId, viewerId);
  }

  @Get('lookup/username/:username/profile/public')
  @UseGuards(OptionalJwtAuthGuard)
  async getPublicProfileByUsername(
    @Param('username') username: string,
    @Req() req,
  ) {
    const viewerId = req?.user?.id ?? req?.user?.sub;
    return this.userProfileService.resolvePublicProfileByUsername(
      username,
      viewerId,
    );
  }

  @Get(':id/profile-photo-view')
  @UseGuards(OptionalJwtAuthGuard)
  async getProfilePhotoViewState(@Param('id') userId: string, @Req() req) {
    const viewerId = req?.user?.id ?? req?.user?.sub;
    return this.userProfileService.getProfilePhotoViewState(userId, viewerId);
  }

  @Post(':id/profile-photo-view')
  @UseGuards(AuthGuard('jwt'))
  async markProfilePhotoViewed(@Param('id') userId: string, @Req() req) {
    return this.userProfileService.markProfilePhotoViewed(
      userId,
      this.getAuthUserId(req),
    );
  }

  @Patch('me/profile-visibility')
  @UseGuards(AuthGuard('jwt'))
  async updateProfileVisibility(
    @Req() req,
    @Body() updateProfileVisibilityDto: UpdateProfileVisibilityDto,
  ) {
    return this.userProfileService.updateProfileVisibility(
      this.getAuthUserId(req),
      updateProfileVisibilityDto.profileVisibility,
    );
  }

  @Patch('me/preferences')
  @UseGuards(AuthGuard('jwt'))
  async updatePreferences(
    @Req() req,
    @Body() updateUserPreferencesDto: UpdateUserPreferencesDto,
  ) {
    return this.userProfileService.updatePreferences(
      this.getAuthUserId(req),
      updateUserPreferencesDto.themePreference,
    );
  }

  @Get(':id/patches')
  @UseGuards(AuthGuard('jwt'))
  async getPatchedBrands(@Param('id') userId: string, @Req() req) {
    const viewerId = this.getAuthUserId(req);
    return this.userProfileService.getPatchedBrands(userId, viewerId);
  }

  @Get(':id/patches/public')
  @UseGuards(OptionalJwtAuthGuard)
  async getPatchedBrandsPublic(@Param('id') userId: string, @Req() req) {
    const viewerId = req?.user?.id ?? req?.user?.sub;
    return this.userProfileService.getPatchedBrands(userId, viewerId);
  }
}
