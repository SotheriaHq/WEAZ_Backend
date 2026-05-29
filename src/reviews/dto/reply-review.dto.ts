import { IsString, MinLength, MaxLength } from 'class-validator';

export class ReplyToProductReviewDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  brandReply: string;
}
