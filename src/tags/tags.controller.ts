import { Controller, Get, Query } from '@nestjs/common';
import { TagsService } from './tags.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('tags')
@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  @ApiOperation({
    summary: 'List popular tags aggregated from collections and brands',
  })
  async list(@Query('limit') limit?: string) {
    const lim = limit ? parseInt(limit, 10) : 50;
    const popular = await this.tags.getPopularTags(lim);
    return popular.map((p) => ({ name: p.tag, usageCount: p.count }));
  }
}
