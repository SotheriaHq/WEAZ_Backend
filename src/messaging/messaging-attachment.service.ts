import { BadRequestException, Injectable } from '@nestjs/common';
import { FileType, MessageAttachmentKind, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class MessagingAttachmentService {
  constructor(private readonly prisma: PrismaService) {}

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

    const totalPayloadBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalPayloadBytes > 25 * 1024 * 1024) {
      throw new BadRequestException('Attachment payload exceeds 25MB');
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
