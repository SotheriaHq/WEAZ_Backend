import { PrismaService } from 'src/prisma/prisma.service';
import { ContentTarget } from '@prisma/client';
export declare class ModerationController {
    private prisma;
    constructor(prisma: PrismaService);
    quarantineThreads(body: {
        userId: string;
        contentId: string;
        contentType: ContentTarget;
        reason?: string;
    }): Promise<{
        success: boolean;
    }>;
    bulkRemoveThreads(body: {
        entries: Array<{
            userId: string;
            contentId: string;
            contentType: ContentTarget;
        }>;
    }): Promise<{
        success: boolean;
        removed: number;
    }>;
}
