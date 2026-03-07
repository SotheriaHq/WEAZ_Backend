import { IsString, MinLength, MaxLength } from 'class-validator';

export class AttemptBreakGlassDto {
  @IsString()
  @MinLength(8)
  @MaxLength(256)
  code: string;
}
