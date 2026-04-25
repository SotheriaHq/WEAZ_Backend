import { MessageAttachmentKind } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
export declare class MessagingAttachmentService {
    private readonly prisma;
    private readonly systemConfigService;
    constructor(prisma: PrismaService, systemConfigService: SystemConfigService);
    resolveValidatedAttachments(userId: string, attachmentFileIds?: string[]): Promise<{
        fileUploadId: string;
        kind: MessageAttachmentKind;
    }[]>;
    private mapKind;
}
