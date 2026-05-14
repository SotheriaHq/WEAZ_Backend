import { BrandMemberRole } from '@prisma/client';
import { IsEmail, IsEnum } from 'class-validator';

export class InviteBrandStaffDto {
  @IsEmail()
  email: string;

  @IsEnum(BrandMemberRole)
  role: BrandMemberRole;
}
