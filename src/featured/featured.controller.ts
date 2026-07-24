import { Controller, Get, Param } from '@nestjs/common';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';
import { AdminFeaturedService } from '../admin/featured/admin-featured.service';

@IsPublic()
@Controller('featured')
export class FeaturedController {
  constructor(private readonly featuredService: AdminFeaturedService) {}

  @Get('active')
  async listActive() {
    return this.featuredService.publicListActive();
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.featuredService.publicGetById(id);
  }
}
