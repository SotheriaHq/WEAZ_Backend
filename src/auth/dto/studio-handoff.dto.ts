import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateStudioHandoffDto {
  @IsString()
  @MaxLength(512)
  @Matches(/^\/studio(?:[/?#].*)?$|^\/studio\/.*$/, {
    message: 'intendedPath must be a Studio path',
  })
  intendedPath!: string;
}

export class ExchangeStudioHandoffDto {
  @IsString()
  @MaxLength(256)
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  intendedPath?: string;
}
