import { IsString } from 'class-validator';

export class AddToWishlistDto {
  @IsString()
  productId: string;
}
