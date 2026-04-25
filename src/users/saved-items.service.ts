import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSavedItemDto, SavedItemTypeDto } from './dto/create-saved-item.dto';

@Injectable()
export class SavedItemsService {
  constructor(private prisma: PrismaService) {}

  async saveItem(userId: string, createSavedItemDto: CreateSavedItemDto) {
    // Check if item already exists in saved items
    const existingSavedItem = await this.prisma.savedItem.findUnique({
      where: {
        userId_targetType_targetId: {
          userId,
          targetType: createSavedItemDto.targetType,
          targetId: createSavedItemDto.targetId,
        },
      },
    });

    if (existingSavedItem) {
      // Item already saved, return as is (idempotent operation)
      return existingSavedItem;
    }

    // Verify the target exists and is accessible
    let targetExists = false;
    if (createSavedItemDto.targetType === SavedItemTypeDto.COLLECTION) {
      const collection = await this.prisma.collection.findUnique({
        where: { id: createSavedItemDto.targetId },
        select: { id: true, ownerId: true },
      });
      targetExists = !!collection;
      if (collection?.ownerId === userId) {
        throw new ForbiddenException('You cannot save your own collection');
      }
    } else if (createSavedItemDto.targetType === SavedItemTypeDto.COLLECTION_MEDIA) {
      const media = await this.prisma.collectionMedia.findUnique({
        where: { id: createSavedItemDto.targetId },
        select: { id: true, collection: { select: { ownerId: true } } },
      });
      targetExists = !!media;
      if (media?.collection?.ownerId === userId) {
        throw new ForbiddenException(
          'You cannot save media from your own collection',
        );
      }
    }

    if (!targetExists) {
      throw new NotFoundException(`${createSavedItemDto.targetType} not found`);
    }

    // Create the saved item
    const savedItem = await this.prisma.savedItem.create({
      data: {
        id: uuidv4(),
        user: { connect: { id: userId } },
        targetType: createSavedItemDto.targetType,
        targetId: createSavedItemDto.targetId,
      },
    });

    return savedItem;
  }

  async unsaveItem(userId: string, createSavedItemDto: CreateSavedItemDto) {
    const deletedSavedItem = await this.prisma.savedItem.deleteMany({
      where: {
        userId,
        targetType: createSavedItemDto.targetType,
        targetId: createSavedItemDto.targetId,
      },
    });

    if (deletedSavedItem.count === 0) {
      throw new NotFoundException(`Saved item not found`);
    }

    return { message: 'Item unsaved successfully' };
  }

  async getUserSavedItems(userId: string) {
    const savedItems = await this.prisma.savedItem.findMany({
      where: {
        userId,
      },
      include: {
        user: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    // Enhance the saved items with additional data from collections or collection media
    const enhancedSavedItems = await Promise.all(
      savedItems.map(async (item) => {
        let additionalData: any = {};

        if (item.targetType === SavedItemTypeDto.COLLECTION) {
          const collection = await this.prisma.collection.findUnique({
            where: { id: item.targetId },
            include: {
              owner: {
                select: {
                  id: true,
                  username: true,
                  firstName: true,
                  lastName: true,
                  profileImage: true,
                },
              },
              medias: {
                take: 1, // Get first media as thumbnail
                include: {
                  file: true,
                },
              },
            },
          });

          if (collection) {
            additionalData = {
              title: collection.title,
              thumbnail: collection.medias[0]?.file.s3Url,
              collectionId: collection.id,
              brand: collection.owner,
            };
          }
        } else if (item.targetType === SavedItemTypeDto.COLLECTION_MEDIA) {
          const media = await this.prisma.collectionMedia.findUnique({
            where: { id: item.targetId },
            include: {
              file: true,
              collection: {
                include: {
                  owner: {
                    select: {
                      id: true,
                      username: true,
                      firstName: true,
                      lastName: true,
                      profileImage: true,
                    },
                  },
                },
              },
            },
          });

          if (media) {
            additionalData = {
              title: media.file.originalName,
              thumbnail: media.file.s3Url,
              collectionId: media.collectionId,
              brand: media.collection.owner,
            };
          }
        }

        return {
          ...item,
          ...additionalData,
        };
      })
    );

    return enhancedSavedItems;
  }

  async checkSavedStatus(userId: string, targetType: SavedItemTypeDto, targetId: string) {
    const savedItem = await this.prisma.savedItem.findUnique({
      where: {
        userId_targetType_targetId: {
          userId,
          targetType,
          targetId,
        },
      },
    });

    return { isSaved: !!savedItem };
  }

  async checkSavedBatch(userId: string, targetType: SavedItemTypeDto, targetIds: string[]) {
    if (!targetIds?.length) {
      throw new BadRequestException('targetIds is required');
    }

    const uniqueIds = Array.from(new Set(targetIds));
    const saved = await this.prisma.savedItem.findMany({
      where: {
        userId,
        targetType,
        targetId: { in: uniqueIds },
      },
      select: { targetId: true },
    });

    const savedSet = new Set(saved.map((item) => item.targetId));
    return {
      items: targetIds.map((id) => ({
        targetId: id,
        isSaved: savedSet.has(id),
      })),
    };
  }
}
