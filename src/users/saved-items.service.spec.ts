import { BadRequestException } from '@nestjs/common';
import { SavedItemTypeDto } from './dto/create-saved-item.dto';
import { SavedItemsService } from './saved-items.service';

describe('SavedItemsService.checkSavedStatus', () => {
  const userId = '0b276284-a917-4c64-95f4-18a8c3cc0aa0';
  const targetId = 'bc692576-3808-4f74-8f4f-0dcfcadb1784';
  const findUnique = jest.fn();
  const service = new SavedItemsService({ savedItem: { findUnique } } as any);

  beforeEach(() => {
    findUnique.mockReset();
  });

  it('reports a saved item', async () => {
    findUnique.mockResolvedValue({ id: 'row' });
    await expect(
      service.checkSavedStatus(userId, SavedItemTypeDto.PRODUCT, targetId),
    ).resolves.toEqual({ isSaved: true });
  });

  it('reports an unsaved item', async () => {
    findUnique.mockResolvedValue(null);
    await expect(
      service.checkSavedStatus(userId, SavedItemTypeDto.DESIGN, targetId),
    ).resolves.toEqual({ isSaved: false });
  });

  // Market rails sent these and each one crashed Prisma into an HTTP 500.
  it.each(['CATEGORY', 'BRAND', '', undefined])(
    'refuses the unsavable type %s without reaching the database',
    async (targetType) => {
      await expect(
        service.checkSavedStatus(userId, targetType as any, targetId),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(findUnique).not.toHaveBeenCalled();
    },
  );

  it.each(['not-a-uuid', '', undefined])(
    'refuses the malformed id %s without reaching the database',
    async (badId) => {
      await expect(
        service.checkSavedStatus(
          userId,
          SavedItemTypeDto.PRODUCT,
          badId as any,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(findUnique).not.toHaveBeenCalled();
    },
  );
});
