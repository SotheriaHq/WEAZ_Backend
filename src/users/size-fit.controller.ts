import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { RespondSizeFitShareDto } from './dto/respond-size-fit-share.dto';
import { ShareSizeFitDto } from './dto/share-size-fit.dto';
import { UpdateSizeFitSettingsDto } from './dto/update-size-fit-settings.dto';
import { UpdateSizeFitDto } from './dto/update-size-fit.dto';
import { SizeFitService } from './size-fit.service';

@Controller('users')
export class SizeFitController {
  constructor(private readonly sizeFitService: SizeFitService) {}

  private getAuthUserId(req: any): string {
    const userId = req?.user?.id ?? req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }
    return userId;
  }

  @Get('me/size-fit')
  @UseGuards(AuthGuard('jwt'))
  async getMySizeFit(@Req() req: any) {
    return this.sizeFitService.getMySizeFit(this.getAuthUserId(req));
  }

  @Get(':id/size-fit/public')
  @UseGuards(OptionalJwtAuthGuard)
  async getSizeFitPublic(@Param('id') ownerId: string, @Req() req: any) {
    const viewerId = req?.user?.id ?? req?.user?.sub;
    return this.sizeFitService.getSizeFitForViewer(ownerId, viewerId);
  }

  @Put('me/size-fit')
  @UseGuards(AuthGuard('jwt'))
  async updateMySizeFit(
    @Req() req: any,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateSizeFitDto,
  ) {
    return this.sizeFitService.updateMySizeFit(this.getAuthUserId(req), dto);
  }

  @Patch('me/size-fit/settings')
  @UseGuards(AuthGuard('jwt'))
  async updateMySizeFitSettings(
    @Req() req: any,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateSizeFitSettingsDto,
  ) {
    return this.sizeFitService.updateMySizeFitSettings(
      this.getAuthUserId(req),
      dto,
    );
  }

  @Get('me/size-fit/shares')
  @UseGuards(AuthGuard('jwt'))
  async getMySizeFitShares(@Req() req: any) {
    return this.sizeFitService.listMySizeFitShareRequests(this.getAuthUserId(req));
  }

  @Post('me/size-fit/share')
  @UseGuards(AuthGuard('jwt'))
  async shareSizeFit(
    @Req() req: any,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: ShareSizeFitDto,
  ) {
    return this.sizeFitService.shareSizeFit(this.getAuthUserId(req), dto);
  }

  @Patch('me/size-fit/share-requests/:shareId')
  @UseGuards(AuthGuard('jwt'))
  async respondToShareRequest(
    @Req() req: any,
    @Param('shareId') shareId: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: RespondSizeFitShareDto,
  ) {
    return this.sizeFitService.respondToShareRequest(
      this.getAuthUserId(req),
      shareId,
      dto,
    );
  }
}

