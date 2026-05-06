import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { BrandStaffService } from './brand-staff.service';
import { BrandStaffInviteTokenDto } from './dto/brand-staff-invite-token.dto';
import { InviteBrandStaffDto } from './dto/invite-brand-staff.dto';
import { UpdateBrandStaffRoleDto } from './dto/update-brand-staff-role.dto';
import { UpdateBrandStaffStatusDto } from './dto/update-brand-staff-status.dto';

@Controller()
export class BrandStaffController {
  constructor(private readonly brandStaffService: BrandStaffService) {}

  @UseGuards(JwtAuthGuard)
  @Get('brands/:brandId/staff')
  async listStaff(@Param('brandId') brandId: string, @Req() req: any) {
    return this.brandStaffService.listStaff(req.user.id, brandId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('brands/:brandId/staff/invite')
  async inviteStaff(
    @Param('brandId') brandId: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: InviteBrandStaffDto,
    @Req() req: any,
  ) {
    return this.brandStaffService.inviteStaff(req.user.id, brandId, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('brands/:brandId/staff/invites/:inviteId')
  async cancelInvite(
    @Param('brandId') brandId: string,
    @Param('inviteId') inviteId: string,
    @Req() req: any,
  ) {
    return this.brandStaffService.cancelInvite(req.user.id, brandId, inviteId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('brands/staff/invites/accept')
  async acceptInvite(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: BrandStaffInviteTokenDto,
    @Req() req: any,
  ) {
    return this.brandStaffService.acceptInvite(req.user.id, dto.token);
  }

  @UseGuards(JwtAuthGuard)
  @Post('brands/staff/invites/reject')
  async rejectInvite(
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: BrandStaffInviteTokenDto,
    @Req() req: any,
  ) {
    return this.brandStaffService.rejectInvite(req.user.id, dto.token);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('brands/:brandId/staff/:memberId/role')
  async updateStaffRole(
    @Param('brandId') brandId: string,
    @Param('memberId') memberId: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateBrandStaffRoleDto,
    @Req() req: any,
  ) {
    return this.brandStaffService.updateStaffRole(
      req.user.id,
      brandId,
      memberId,
      dto.role,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Patch('brands/:brandId/staff/:memberId/status')
  async updateStaffStatus(
    @Param('brandId') brandId: string,
    @Param('memberId') memberId: string,
    @Body(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }))
    dto: UpdateBrandStaffStatusDto,
    @Req() req: any,
  ) {
    return this.brandStaffService.updateStaffStatus(
      req.user.id,
      brandId,
      memberId,
      dto.status,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Delete('brands/:brandId/staff/:memberId')
  async removeStaff(
    @Param('brandId') brandId: string,
    @Param('memberId') memberId: string,
    @Req() req: any,
  ) {
    return this.brandStaffService.removeStaff(req.user.id, brandId, memberId);
  }
}
