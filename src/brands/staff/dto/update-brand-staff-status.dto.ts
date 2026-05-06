import { BrandMemberStatus } from '@prisma/client';
import { IsEnum } from 'class-validator';

export class UpdateBrandStaffStatusDto {
  @IsEnum(BrandMemberStatus)
  status: BrandMemberStatus;
}
