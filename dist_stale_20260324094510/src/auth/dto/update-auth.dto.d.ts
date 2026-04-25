import { UserType } from '@prisma/client';
export declare class UpdateAuthDto {
    username?: string;
    email?: string;
    phoneNumber?: string;
    address?: string;
    firstName?: string;
    lastName?: string;
    brandFullName?: string;
    type?: UserType;
    isActive?: string;
}
