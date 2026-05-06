import { BrandMemberRole } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateBrandStaffRoleDto {
  @IsEnum(BrandMemberRole)
  role: BrandMemberRole;
}
