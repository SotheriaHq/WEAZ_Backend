import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';

export type DesignTaxonomyState = {
  categoryId?: string | null;
  categoryTypeId?: string | null;
  pendingCategorySuggestionId?: string | null;
  pendingCategoryName?: string | null;
  originalSuggestionId?: string | null;
};

/** Resolve taxonomy inside the source write transaction; publication stays separate. */
export async function resolveDesignTaxonomy(
  tx: Prisma.TransactionClient,
  input: DesignTaxonomyState,
  existing: DesignTaxonomyState,
  access: { actorUserId: string; ownerUserId: string },
  requireComplete = false,
): Promise<Required<DesignTaxonomyState>> {
  const selectsApproved = input.categoryId != null;
  const proposalId =
    input.pendingCategorySuggestionId !== undefined
      ? input.pendingCategorySuggestionId
      : selectsApproved
        ? null
        : existing.pendingCategorySuggestionId;
  if (proposalId) {
    if (!isUUID(proposalId))
      throw new BadRequestException('Invalid category proposal');
    if (input.categoryId || input.categoryTypeId)
      throw new BadRequestException(
        'Choose an approved category or a proposed category and garment type.',
      );
    const proposal = await tx.collectionCategorySuggestion.findUnique({
      where: { id: proposalId },
    });
    if (!proposal) throw new NotFoundException('Category proposal not found');
    if (
      proposalId !== existing.pendingCategorySuggestionId &&
      ![access.actorUserId, access.ownerUserId].includes(
        proposal.proposedByUserId,
      )
    ) {
      const colleague = await tx.brandMember.findFirst({
        where: {
          userId: proposal.proposedByUserId,
          status: 'ACTIVE',
          brand: { ownerId: access.ownerUserId },
        },
        select: { id: true },
      });
      if (!colleague)
        throw new NotFoundException('Category proposal not found');
    }
    if (!proposal.garmentTypeName || !proposal.garmentTypeSlug)
      throw new BadRequestException(
        'Propose the category and garment type together.',
      );
    if (proposal.status === 'REJECTED')
      throw new BadRequestException(
        'This category proposal was rejected. Choose another category or submit a new proposal.',
      );
    if (proposal.status === 'PENDING')
      return {
        categoryId: null,
        categoryTypeId: null,
        pendingCategorySuggestionId: proposal.id,
        pendingCategoryName: proposal.name,
        originalSuggestionId: proposal.id,
      };
    if (!proposal.approvedCategoryId || !proposal.approvedCategoryTypeId)
      throw new BadRequestException(
        'The category and garment type approval is incomplete.',
      );
    await assertApprovedPair(
      tx,
      proposal.approvedCategoryId,
      proposal.approvedCategoryTypeId,
    );
    return {
      categoryId: proposal.approvedCategoryId,
      categoryTypeId: proposal.approvedCategoryTypeId,
      pendingCategorySuggestionId: null,
      pendingCategoryName: null,
      originalSuggestionId: proposal.id,
    };
  }
  const categoryId =
    input.categoryId !== undefined
      ? input.categoryId
      : (existing.categoryId ?? null);
  const changedCategory =
    input.categoryId !== undefined && input.categoryId !== existing.categoryId;
  const categoryTypeId =
    input.categoryTypeId !== undefined
      ? input.categoryTypeId
      : changedCategory
        ? null
        : (existing.categoryTypeId ?? null);
  if (requireComplete && (!categoryId || !categoryTypeId))
    throw new BadRequestException(
      'Choose an approved category and garment type, or propose both together.',
    );
  if (categoryId) {
    if (!isUUID(categoryId)) throw new BadRequestException('Invalid category');
    const category = await tx.collectionCategory.findUnique({
      where: { id: categoryId },
      select: { isActive: true },
    });
    if (!category?.isActive)
      throw new BadRequestException('Choose an active approved category.');
  }
  if (categoryTypeId) {
    if (!categoryId)
      throw new BadRequestException(
        'Choose the category for this garment type.',
      );
    await assertApprovedPair(tx, categoryId, categoryTypeId);
  }
  return {
    categoryId,
    categoryTypeId,
    pendingCategorySuggestionId: null,
    pendingCategoryName: null,
    originalSuggestionId: existing.originalSuggestionId ?? null,
  };
}

async function assertApprovedPair(
  tx: Prisma.TransactionClient,
  categoryId: string,
  typeId: string,
) {
  if (!isUUID(typeId)) throw new BadRequestException('Invalid garment type');
  const type = await tx.collectionCategoryType.findUnique({
    where: { id: typeId },
    select: {
      categoryId: true,
      isActive: true,
      category: { select: { isActive: true } },
    },
  });
  if (
    !type?.isActive ||
    !type.category.isActive ||
    type.categoryId !== categoryId
  )
    throw new BadRequestException(
      'Choose an active garment type belonging to this category.',
    );
}
