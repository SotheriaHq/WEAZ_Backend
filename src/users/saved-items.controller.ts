import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  UseGuards,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SavedItemsService } from './saved-items.service';
import { CreateSavedItemDto } from './dto/create-saved-item.dto';
import { CheckSavedBatchDto } from './dto/check-saved-batch.dto';

@Controller('saved')
export class SavedItemsController {
  constructor(private readonly savedItemsService: SavedItemsService) {}

  private getAuthUserId(req: any): string {
    const userId = req?.user?.id ?? req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }
    return userId;
  }

  @Post()
  @UseGuards(AuthGuard('jwt'))
  async saveItem(@Req() req, @Body() createSavedItemDto: CreateSavedItemDto) {
    return this.savedItemsService.saveItem(this.getAuthUserId(req), createSavedItemDto);
  }

  @Delete()
  @UseGuards(AuthGuard('jwt'))
  async unsaveItem(@Req() req, @Body() createSavedItemDto: CreateSavedItemDto) {
    return this.savedItemsService.unsaveItem(this.getAuthUserId(req), createSavedItemDto);
  }

  @Get('me')
  @UseGuards(AuthGuard('jwt'))
  async getUserSavedItems(@Req() req) {
    return this.savedItemsService.getUserSavedItems(this.getAuthUserId(req));
  }

  @Get('check')
  @UseGuards(AuthGuard('jwt'))
  async checkSavedStatus(@Req() req) {
    const { targetType, targetId } = req.query;
    return this.savedItemsService.checkSavedStatus(
      this.getAuthUserId(req),
      targetType as any,
      targetId as string,
    );
  }

  @Post('check/batch')
  @UseGuards(AuthGuard('jwt'))
  async checkSavedStatusBatch(@Req() req, @Body() dto: CheckSavedBatchDto) {
    return this.savedItemsService.checkSavedBatch(
      this.getAuthUserId(req),
      dto.targetType,
      dto.targetIds,
    );
  }
}
