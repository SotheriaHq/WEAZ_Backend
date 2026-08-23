import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PatchMode, PatchStatus } from '@prisma/client';
import { PatchingService } from './patching.service';

/**
 * A brand has TWO ids and callers legitimately hold either.
 *
 * `PatchConnection.targetId` is a User id. But the market feed puts
 * `Brand.id` in `brand.id`, so every patch attempted from the Runway sent a
 * `Brand.id` to an endpoint that looked it up in `prisma.user` — 404 "Brand not
 * found" on web and native alike. `checkPatchStatus` failed more quietly: it
 * matched no connection and answered `isPatched: false`, so the pill also read
 * "not patched" for brands the shopper had already patched.
 *
 * `BrandsService.getBrandOrThrow` has always accepted both, so both are part of
 * this API's `:brandId` contract. These tests pin that patching agrees.
 */

const BRAND_USER_ID = 'brand-user-id';
const BRAND_RECORD_ID = 'brand-record-id';
const SHOPPER_ID = 'shopper-user-id';

describe('PatchingService brand id resolution', () => {
  let prisma: {
    user: { findUnique: jest.Mock; findMany: jest.Mock };
    brand: { findUnique: jest.Mock; findMany: jest.Mock };
    patchConnection: {
      findUnique: jest.Mock;
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let service: PatchingService;

  /** Only `BRAND_USER_ID` exists in `user`; `BRAND_RECORD_ID` only in `brand`. */
  const wireBrandLookups = () => {
    prisma.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === BRAND_USER_ID) {
        return { id: BRAND_USER_ID, type: 'BRAND', username: 'wiez-brand', brand: { name: 'WIEZ Brand' } };
      }
      if (where.id === SHOPPER_ID) {
        return { id: SHOPPER_ID, type: 'REGULAR', username: 'shopper', brand: null };
      }
      return null;
    });
    prisma.brand.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === BRAND_RECORD_ID ? { ownerId: BRAND_USER_ID } : null,
    );
  };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), findMany: jest.fn() },
      brand: { findUnique: jest.fn(), findMany: jest.fn() },
      patchConnection: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    service = new PatchingService(prisma as any);
    wireBrandLookups();
  });

  describe('patchBrand', () => {
    it('patches when handed the Brand record id, which is what the feed sends', async () => {
      prisma.patchConnection.findUnique.mockResolvedValue(null);
      prisma.patchConnection.create.mockImplementation(async ({ data }: any) => ({
        id: 'connection-id',
        ...data,
      }));

      await service.patchBrand(SHOPPER_ID, BRAND_RECORD_ID);

      // The connection must be written against the USER id, never the Brand id —
      // that is what every read of this table (and /users/:id/patches) uses.
      expect(prisma.patchConnection.create).toHaveBeenCalledTimes(1);
      const created = prisma.patchConnection.create.mock.calls[0][0].data;
      expect(created.target.connect.id).toBe(BRAND_USER_ID);
      expect(created.requester.connect.id).toBe(SHOPPER_ID);
      expect(created.status).toBe(PatchStatus.ACCEPTED);
      expect(created.mode).toBe(PatchMode.USER_TO_BRAND);
    });

    it('still patches when handed the brand owner user id', async () => {
      prisma.patchConnection.findUnique.mockResolvedValue(null);
      prisma.patchConnection.create.mockImplementation(async ({ data }: any) => ({
        id: 'connection-id',
        ...data,
      }));

      await service.patchBrand(SHOPPER_ID, BRAND_USER_ID);

      expect(prisma.patchConnection.create.mock.calls[0][0].data.target.connect.id).toBe(
        BRAND_USER_ID,
      );
    });

    it('404s only when the id is neither a user nor a brand', async () => {
      await expect(service.patchBrand(SHOPPER_ID, 'not-an-id')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.patchConnection.create).not.toHaveBeenCalled();
    });

    it('rejects self-patching through the Brand id, not just the user id', async () => {
      // The owner holds their own Brand.id: without resolving FIRST, the
      // requesterId === brandId guard compares two different ids and lets it past.
      prisma.user.findUnique.mockImplementation(async ({ where }: any) =>
        where.id === BRAND_USER_ID
          ? { id: BRAND_USER_ID, type: 'REGULAR', username: 'owner', brand: null }
          : null,
      );

      await expect(service.patchBrand(BRAND_USER_ID, BRAND_RECORD_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.patchConnection.create).not.toHaveBeenCalled();
    });

    it('is idempotent — re-patching an accepted connection writes nothing', async () => {
      prisma.patchConnection.findUnique.mockResolvedValue({
        id: 'connection-id',
        status: PatchStatus.ACCEPTED,
      });

      await service.patchBrand(SHOPPER_ID, BRAND_RECORD_ID);

      expect(prisma.patchConnection.create).not.toHaveBeenCalled();
      expect(prisma.patchConnection.update).not.toHaveBeenCalled();
    });
  });

  describe('unpatchBrand', () => {
    it('unpatches when handed the Brand record id', async () => {
      prisma.patchConnection.findFirst.mockResolvedValue({ id: 'connection-id' });
      prisma.patchConnection.deleteMany.mockResolvedValue({ count: 1 });

      await service.unpatchBrand(SHOPPER_ID, BRAND_RECORD_ID);

      expect(prisma.patchConnection.deleteMany).toHaveBeenCalledWith({
        where: {
          requesterId: SHOPPER_ID,
          targetId: BRAND_USER_ID,
          mode: PatchMode.USER_TO_BRAND,
        },
      });
    });
  });

  describe('checkPatchStatus', () => {
    it('reports the true state for a Brand record id', async () => {
      prisma.patchConnection.findUnique.mockResolvedValue({
        id: 'connection-id',
        status: PatchStatus.ACCEPTED,
      });

      const result = await service.checkPatchStatus(SHOPPER_ID, BRAND_RECORD_ID);

      expect(result).toEqual({ isPatched: true });
      expect(prisma.patchConnection.findUnique).toHaveBeenCalledWith({
        where: {
          requesterId_targetId: { requesterId: SHOPPER_ID, targetId: BRAND_USER_ID },
        },
      });
    });
  });

  describe('checkPatchBatch', () => {
    it('resolves a mixed batch and keys the answers by the id the caller asked about', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: BRAND_USER_ID }]);
      prisma.brand.findMany.mockResolvedValue([
        { id: BRAND_RECORD_ID, ownerId: BRAND_USER_ID },
      ]);
      prisma.patchConnection.findMany.mockResolvedValue([{ targetId: BRAND_USER_ID }]);

      const result = await service.checkPatchBatch(SHOPPER_ID, [
        BRAND_RECORD_ID,
        BRAND_USER_ID,
        'unknown-id',
      ]);

      // Both spellings of the same brand answer true; the client looks results
      // up by the id it holds, so the keys must be the requested ones.
      expect(result.items).toEqual([
        { targetId: BRAND_RECORD_ID, isPatched: true },
        { targetId: BRAND_USER_ID, isPatched: true },
        { targetId: 'unknown-id', isPatched: false },
      ]);
    });

    it('does not 404 the whole batch because one id is stale', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.brand.findMany.mockResolvedValue([]);
      prisma.patchConnection.findMany.mockResolvedValue([]);

      await expect(
        service.checkPatchBatch(SHOPPER_ID, ['gone-1', 'gone-2']),
      ).resolves.toEqual({
        items: [
          { targetId: 'gone-1', isPatched: false },
          { targetId: 'gone-2', isPatched: false },
        ],
      });
    });

    it('queries the brand table only for ids that were not users', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: BRAND_USER_ID }]);
      prisma.brand.findMany.mockResolvedValue([]);
      prisma.patchConnection.findMany.mockResolvedValue([]);

      await service.checkPatchBatch(SHOPPER_ID, [BRAND_USER_ID, BRAND_RECORD_ID]);

      // Two queries for a screenful of brands, not two per brand.
      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.brand.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.brand.findMany.mock.calls[0][0].where.id.in).toEqual([BRAND_RECORD_ID]);
    });
  });
});
