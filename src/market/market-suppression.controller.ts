import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import {
  CreateMarketSuppressionDto,
  MarketSuppressionQueryDto,
} from './dto/market-signal.dto';
import { MarketSuppressionService } from './market-suppression.service';

@ApiTags('market')
@IsPublic()
@UseGuards(OptionalJwtAuthGuard)
@Controller('market')
export class MarketSuppressionController {
  constructor(
    private readonly marketSuppressionService: MarketSuppressionService,
  ) {}

  @Post('suppressions')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Create a market content suppression' })
  async createSuppression(
    @Body() dto: CreateMarketSuppressionDto,
    @Req() req: any,
  ) {
    return this.marketSuppressionService.createSuppression(dto, {
      userId: req?.user?.id ?? req?.user?.sub ?? null,
      anonymousSessionId: dto.anonymousSessionId,
    });
  }

  @Get('suppressions')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @ApiOperation({ summary: 'List active market content suppressions' })
  async listSuppressions(
    @Query() query: MarketSuppressionQueryDto,
    @Req() req: any,
  ) {
    return this.marketSuppressionService.listSuppressions(
      {
        userId: req?.user?.id ?? req?.user?.sub ?? null,
        anonymousSessionId: query.anonymousSessionId,
      },
      query,
    );
  }

  @Delete('suppressions/:id')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @ApiOperation({ summary: 'Delete a market content suppression' })
  async deleteSuppression(
    @Param('id') id: string,
    @Query() query: MarketSuppressionQueryDto,
    @Req() req: any,
  ) {
    return this.marketSuppressionService.deleteSuppression(
      id,
      {
        userId: req?.user?.id ?? req?.user?.sub ?? null,
        anonymousSessionId: query.anonymousSessionId,
      },
      query,
    );
  }
}
