import { IsArray, IsString } from 'class-validator';

export class UpdatePermissionsDto {
  @IsArray()
  @IsString({ each: true })
  permissions: string[];
}
