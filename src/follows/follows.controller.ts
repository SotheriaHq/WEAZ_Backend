import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  Delete,
  Param,
  Get,
  Query,
} from '@nestjs/common';
import { FollowsService } from './follows.service';
import { CreateFollowDto } from './dto/create-follow.dto';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';

@ApiTags('follows')
@Controller('follows')
export class FollowsController {
  constructor(private readonly followsService: FollowsService) {}

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post()
  @ApiOperation({ summary: 'Follow a user/brand' })
  @ApiResponse({ status: 201, description: 'Follow created' })
  async follow(@Req() req: any, @Body() dto: CreateFollowDto) {
    return this.followsService.follow(req.user.id, dto);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Delete(':targetId')
  @ApiOperation({ summary: 'Unfollow a user/brand' })
  @ApiResponse({ status: 200, description: 'Unfollowed' })
  async unfollow(@Req() req: any, @Param('targetId') targetId: string) {
    return this.followsService.unfollow(req.user.id, targetId);
  }

  @Get('followers/:userId')
  async getFollowers(
    @Param('userId') userId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.followsService.getFollowers(
      userId,
      limit ? parseInt(limit) : 20,
      cursor,
    );
  }

  @Get('following/:userId')
  async getFollowing(
    @Param('userId') userId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.followsService.getFollowing(
      userId,
      limit ? parseInt(limit) : 20,
      cursor,
    );
  }
}
