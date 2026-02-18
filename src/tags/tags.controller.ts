import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { TagsService } from './tags.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { Role } from '@prisma/client';

@ApiTags('tags')
@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  @ApiOperation({
    summary: 'List popular tags',
  })
  async list(@Query('limit') limit?: string) {
    const lim = limit ? parseInt(limit, 10) : 50;
    const popular = await this.tags.getPopularTags(lim);
    return popular.map((p) => ({ name: p.tag, usageCount: p.count }));
  }

  @Get('search')
  @ApiOperation({
    summary: 'Search tags by prefix',
  })
  async search(@Query('q') q = '', @Query('limit') limit?: string) {
    const lim = limit ? parseInt(limit, 10) : 10;
    const rows = await this.tags.searchTags(q, lim);
    return {
      query: q,
      items: rows.map((p) => ({ name: p.tag, usageCount: p.count })),
    };
  }

  @Get('trending')
  @ApiOperation({
    summary: 'List trending tags for a time window',
  })
  async trending(
    @Query('window') window = '24h',
    @Query('limit') limit?: string,
  ) {
    const lim = limit ? parseInt(limit, 10) : 20;
    const rows = await this.tags.getTrendingTags(window, lim);
    return {
      window,
      items: rows.map((p) => ({ name: p.tag, usageCount: p.count })),
    };
  }

  @Get(':normalizedName')
  @ApiOperation({
    summary: 'Get tag details',
  })
  async details(@Param('normalizedName') normalizedName: string) {
    return this.tags.getTagDetails(normalizedName);
  }

  @Get(':normalizedName/posts')
  @ApiOperation({
    summary: 'Get cursor-paginated feed for a tag',
  })
  async feed(
    @Param('normalizedName') normalizedName: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    const lim = limit ? parseInt(limit, 10) : 20;
    return this.tags.getTagFeed(normalizedName, cursor, lim);
  }

  @Post('admin/ban/:normalizedName')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiOperation({
    summary: 'Ban or unban a tag',
  })
  async ban(
    @Param('normalizedName') normalizedName: string,
    @Query('banned') banned?: string,
  ) {
    const shouldBan =
      banned === undefined ? true : ['1', 'true', 'yes', 'on'].includes(banned.toLowerCase());
    await this.tags.banTag(normalizedName, shouldBan);
    return { success: true, normalizedName, banned: shouldBan };
  }

  @Post('admin/merge')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiOperation({
    summary: 'Merge source tag into target tag',
  })
  async merge(@Body() body: { sourceTag: string; targetTag: string }) {
    await this.tags.mergeTags(body?.sourceTag, body?.targetTag);
    return { success: true };
  }

  @Post('admin/reindex')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin)
  @ApiOperation({
    summary: 'Rebuild unified tag index from existing entities',
  })
  async reindex() {
    return this.tags.reindexAllTags();
  }
}
