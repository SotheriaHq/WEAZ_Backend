import { BadRequestException, Injectable } from '@nestjs/common';
import { FileType, MessageAttachmentKind, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';

@Injectable()
export class MessagingAttachmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async resolveValidatedAttachments(userId: string, attachmentFileIds?: string[]) {
    const fileIds = Array.from(new Set((attachmentFileIds ?? []).filter(Boolean)));
    if (fileIds.length === 0) {
      return [] as Array<{ fileUploadId: string; kind: MessageAttachmentKind }>;
    }

    if (fileIds.length > 5) {
      throw new BadRequestException('A maximum of 5 attachments is allowed');
    }

    const files = await this.prisma.fileUpload.findMany({
      where: { id: { in: fileIds }, userId },
      select: { id: true, fileType: true, size: true },
    });

    if (files.length !== fileIds.length) {
      throw new BadRequestException('One or more attachments are invalid or not owned by actor');
    }

    const docCount = files.filter((f) => f.fileType === FileType.MESSAGE_DOCUMENT).length;
    if (docCount > 2) {
      throw new BadRequestException('A maximum of 2 documents is allowed per message');
    }

    // Per-file limits: check each file against its type-specific config limit
    const imageLimit = await this.systemConfigService.getMaxFileSize('upload.maxSize.messageImage');
    const docLimit = await this.systemConfigService.getMaxFileSize('upload.maxSize.messageDocument');
    for (const file of files) {
      const limit = file.fileType === FileType.MESSAGE_DOCUMENT ? docLimit : imageLimit;
      if (file.size > limit) {
        const limitMB = (limit / (1024 * 1024));
        throw new BadRequestException(
          `File exceeds the ${limitMB % 1 === 0 ? limitMB : limitMB.toFixed(1)}MB limit`,
        );
      }
    }

    return files.map((file) => ({
      fileUploadId: file.id,
      kind: this.mapKind(file.fileType),
    }));
  }

  private mapKind(fileType: FileType): MessageAttachmentKind {
    if (fileType === FileType.MESSAGE_IMAGE) return MessageAttachmentKind.IMAGE;
    if (fileType === FileType.MESSAGE_DOCUMENT) return MessageAttachmentKind.DOCUMENT;
    throw new BadRequestException('Unsupported attachment type for messaging');
  }
}
