import { Body, Controller, Header, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { ResetFeedPreferencesDto } from './dto/feed-preferences.dto';
import { FeedPreferencesService } from './feed-preferences.service';

@ApiTags('user preferences')
@UseGuards(JwtAuthGuard)
@Controller('user/preferences/feed')
export class FeedPreferencesController {
  constructor(private readonly feedPreferencesService: FeedPreferencesService) {}

  @Post('reset')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Create a feed personalization reset marker' })
  async resetFeedPreferences(
    @Body() dto: ResetFeedPreferencesDto,
    @Req() req: any,
  ) {
    return this.feedPreferencesService.resetFeedPreferences(
      req.user.id ?? req.user.sub,
      dto,
    );
  }
}
