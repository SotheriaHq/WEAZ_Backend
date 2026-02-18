import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { UserProfileService } from './user-profile.service';
import { UpdateProfileVisibilityDto } from './dto/update-profile-visibility.dto';
import { UserProfileResponseDto } from './dto/user-profile.dto';
import { OptionalJwtAuthGuard } from '../auth/guard/optional-jwt-auth.guard';

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

  @Get(':id/profile')
  @UseGuards(AuthGuard('jwt'))
  async getPublicProfile(@Param('id') userId: string, @Req() req) {
    const viewerId = this.getAuthUserId(req);
    return this.userProfileService.getPublicProfile(userId, viewerId);
  }

  @Get(':id/profile/public')
  @UseGuards(OptionalJwtAuthGuard)
  async getPublicProfileAnonymous(@Param('id') userId: string, @Req() req) {
    const viewerId = req?.user?.id ?? req?.user?.sub;
    return this.userProfileService.getPublicProfile(userId, viewerId);
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
