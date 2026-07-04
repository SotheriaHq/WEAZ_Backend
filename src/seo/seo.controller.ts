import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { IsPublic } from '../auth/decorator/is-public.decorator';
import { Throttle } from '@nestjs/throttler';
import { SeoService } from './seo.service';

@IsPublic()
@Controller('public/seo')
export class SeoController {
  constructor(private readonly seoService: SeoService) {}

  @Get('resolve')
  @Throttle({ default: { limit: 180, ttl: 60000 } })
  async resolvePageMeta(@Query('path') path?: string) {
    return this.seoService.resolvePageMeta(path ?? '/');
  }

  @Get('bot-html')
  @Throttle({ default: { limit: 180, ttl: 60000 } })
  @Header('Content-Type', 'text/html; charset=utf-8')
  async renderBotHtml(@Query('path') path: string | undefined, @Res() res: Response) {
    const meta = await this.seoService.resolvePageMeta(path ?? '/');
    res.status(meta.httpStatus).type('html').send(this.seoService.buildBotHtml(meta));
  }

  @Get('robots.txt')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Content-Type', 'text/plain; charset=utf-8')
  renderRobotsTxt(@Res() res: Response) {
    res.status(200).type('text/plain').send(this.seoService.buildRobotsTxt());
  }

  @Get('sitemap.xml')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Header('Content-Type', 'application/xml; charset=utf-8')
  async renderSitemapXml(@Res() res: Response) {
    const xml = await this.seoService.buildSitemapXml();
    res.status(200).type('application/xml').send(xml);
  }
}