import { ArrayUnique, IsArray, IsString } from 'class-validator';

export class UpdateBrandMemberPermissionsDto {
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions: string[];
}
