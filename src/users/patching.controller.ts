import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  UseGuards,
  Req,
  Body,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PatchingService } from './patching.service';
import { CheckPatchBatchDto } from './dto/check-patch-batch.dto';
import { UserTypeGuard } from '../auth/guard/user-type.guard';
import { UserType } from '@prisma/client';

@Controller('brands/:brandId')
export class PatchingController {
  constructor(private readonly patchingService: PatchingService) {}

  private getAuthUserId(req: any): string {
    const userId = req?.user?.id ?? req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }
    return userId;
  }

  @Post('patches')
  @UseGuards(AuthGuard('jwt'), new UserTypeGuard(UserType.REGULAR))
  async patchBrand(@Param('brandId') brandId: string, @Req() req) {
    return this.patchingService.patchBrand(this.getAuthUserId(req), brandId);
  }

  @Delete('patches')
  @UseGuards(AuthGuard('jwt'), new UserTypeGuard(UserType.REGULAR))
  async unpatchBrand(@Param('brandId') brandId: string, @Req() req) {
    return this.patchingService.unpatchBrand(this.getAuthUserId(req), brandId);
  }

  @Get('patches/check')
  @UseGuards(AuthGuard('jwt'), new UserTypeGuard(UserType.REGULAR))
  async checkPatchStatus(@Param('brandId') brandId: string, @Req() req) {
    return this.patchingService.checkPatchStatus(
      this.getAuthUserId(req),
      brandId,
    );
  }
}

@Controller('users/:userId/patches')
export class UserPatchesController {
  constructor(private readonly patchingService: PatchingService) {}

  private getAuthUserId(req: any): string {
    const userId = req?.user?.id ?? req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }
    return userId;
  }

  @Get()
  @UseGuards(AuthGuard('jwt'))
  async getUserPatches(@Param('userId') userId: string, @Req() req) {
    // Allow users to see their own patches, or if they have permission to view others
    const viewerId = this.getAuthUserId(req);
    if (viewerId !== userId) {
      // For now, only allow viewing own patches
      // In the future, this could be expanded based on privacy settings
      throw new ForbiddenException(
        'Permission denied: Can only view own patches',
      );
    }
    return this.patchingService.getBrandPatches(userId);
  }
}

@Controller('brands')
export class PatchStatusBatchController {
  constructor(private readonly patchingService: PatchingService) {}

  private getAuthUserId(req: any): string {
    const userId = req?.user?.id ?? req?.user?.sub;
    if (!userId) {
      throw new UnauthorizedException('Unauthorized');
    }
    return userId;
  }

  @Post('patches/check/batch')
  @UseGuards(AuthGuard('jwt'), new UserTypeGuard(UserType.REGULAR))
  async checkPatchStatusBatch(@Req() req, @Body() dto: CheckPatchBatchDto) {
    return this.patchingService.checkPatchBatch(
      this.getAuthUserId(req),
      dto.targetIds,
    );
  }
}
