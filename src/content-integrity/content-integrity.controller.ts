import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { IdempotencyInterceptor } from 'src/common/interceptors/idempotency.interceptor';
import { ContentIntegrityService } from './content-integrity.service';
import { ContentReportCreateDto } from './dto/content-report.dto';

@Controller('content-integrity')
export class ContentIntegrityController {
  constructor(private readonly contentIntegrity: ContentIntegrityService) {}

  @Get('review-reason-codes')
  reviewReasonCodes() {
    return this.contentIntegrity.getReasonCodes();
  }

  @Get('report-reason-codes')
  reportReasonCodes() {
    return this.contentIntegrity.getReportReasonCodes();
  }

  @UseGuards(JwtAuthGuard)
  @Get('submissions/:id')
  getMySubmission(@Param('id') id: string, @Req() req: any) {
    return this.contentIntegrity.getOwnerSubmission(id, req.user.id);
  }

  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Throttle({ default: { limit: 8, ttl: 60000 } })
  @Post('reports')
  reportContent(
    @Body(ValidationPipe) dto: ContentReportCreateDto,
    @Req() req: any,
  ) {
    return this.contentIntegrity.reportContent({
      reporterId: req.user.id,
      targetType: dto.targetType,
      targetId: dto.targetId,
      mediaId: dto.mediaId,
      reasonCode: dto.reasonCode,
      note: dto.note,
    });
  }
}
