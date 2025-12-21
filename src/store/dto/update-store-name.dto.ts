import { IsString, MinLength, MaxLength } from 'class-validator';

export class UpdateStoreNameDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  newName: string;

  @IsString()
  @MinLength(6)
  @MaxLength(200)
  currentPassword: string;
}
