import { Body, Controller, Header, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { MarketSignalBatchDto } from './dto/market-signal.dto';
import { MarketSignalService } from './market-signal.service';

@ApiTags('market')
@IsPublic()
@UseGuards(OptionalJwtAuthGuard)
@Controller('market')
export class MarketSignalController {
  constructor(private readonly marketSignalService: MarketSignalService) {}

  @Post('signals/batch')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'Ingest bounded market/feed signal batches' })
  async ingestSignalBatch(@Body() dto: MarketSignalBatchDto, @Req() req: any) {
    return this.marketSignalService.ingestBatch(dto, {
      userId: req?.user?.id ?? req?.user?.sub ?? null,
      anonymousSessionId: dto.anonymousSessionId,
    });
  }
}
