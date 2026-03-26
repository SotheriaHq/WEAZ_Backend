import { PrismaService } from 'src/prisma/prisma.service';
import { Role } from '@prisma/client';
export declare class ProfileService {
    private readonly prisma;
    private readonly logger;
    constructor(prisma: PrismaService);
    getProfile(userId: string, requestingUser: {
        id: string;
        role: Role;
    }): Promise<{
        id: string;
        createdAt: Date;
        updatedAt: Date;
        username: string;
        email: string;
        cacNumber: string;
        tin: string;
        ceoNin: string;
        industriNumber: string;
        role: import("@prisma/client").$Enums.Role;
        type: import("@prisma/client").$Enums.UserType;
        firstName: string;
        lastName: string;
        phoneNumber: string;
        address: string;
        brandFullName: string;
        ceoFirstName: string;
        ceoLastName: string;
        companyLocation: string;
    }>;
    private getProfileSelect;
}
