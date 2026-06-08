import { Body, Controller, Get, Post, Req, UseGuards, ValidationPipe } from '@nestjs/common';
import { LegalAcceptanceSource } from '@prisma/client';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { LegalAcceptDto } from './dto/legal-acceptance.dto';
import { LegalService } from './legal.service';

@Controller('legal')
export class LegalController {
  constructor(private readonly legalService: LegalService) {}

  @Get('versions')
  getVersions() {
    return this.legalService.getCurrentVersions();
  }

  @UseGuards(JwtAuthGuard)
  @Post('accept')
  async accept(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: LegalAcceptDto,
    @Req() req: Request & { user?: { id?: string; sub?: string; type?: string } },
  ) {
    const userId = req.user?.id ?? req.user?.sub;
    await this.legalService.recordAcceptedDocuments({
      userId: String(userId),
      acceptances: dto.acceptances,
      source: dto.source ?? LegalAcceptanceSource.MANUAL,
      surface: dto.surface ?? 'legal-center',
      req,
      locale: dto.locale,
      appVersion: dto.appVersion,
      metadata: dto.metadata ?? null,
    });
    return { message: 'Legal acceptance recorded' };
  }

  @UseGuards(JwtAuthGuard)
  @Get('my-acceptances')
  async myAcceptances(
    @Req() req: Request & { user?: { id?: string; sub?: string } },
  ) {
    const userId = req.user?.id ?? req.user?.sub;
    return this.legalService.listUserAcceptances(String(userId));
  }
}
