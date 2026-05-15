import { PrismaService } from 'src/prisma/prisma.service';

export type AdminCatalogFilter = {
  dimensionId: string;
  dimensionSlug: string;
  dimensionName: string;
  valueId: string;
  valueSlug: string;
  valueName: string;
};

export type AdminCatalogFilterMetadata = {
  filterValueIds: string[];
  filters: AdminCatalogFilter[];
};

export const emptyAdminCatalogFilterMetadata = (): AdminCatalogFilterMetadata => ({
  filterValueIds: [],
  filters: [],
});

export async function loadAdminCatalogFilters(
  prisma: PrismaService,
  entityType: 'COLLECTION' | 'STORE_COLLECTION' | 'DESIGN' | 'PRODUCT',
  entityIds: string[],
): Promise<Map<string, AdminCatalogFilterMetadata>> {
  const uniqueEntityIds = Array.from(
    new Set(entityIds.filter((id) => typeof id === 'string' && id.trim())),
  );
  const metadataByEntityId = new Map<string, AdminCatalogFilterMetadata>();
  uniqueEntityIds.forEach((id) => metadataByEntityId.set(id, emptyAdminCatalogFilterMetadata()));
  if (uniqueEntityIds.length === 0) return metadataByEntityId;

  const rows = await prisma.entityFilter.findMany({
    where: {
      entityType: entityType as any,
      entityId: { in: uniqueEntityIds },
    },
    select: {
      entityId: true,
      filterValueId: true,
      filterValue: {
        select: {
          id: true,
          slug: true,
          name: true,
          order: true,
          dimension: {
            select: {
              id: true,
              slug: true,
              name: true,
              order: true,
            },
          },
        },
      },
    },
  });

  rows
    .sort((left, right) => {
      const leftDimensionOrder = left.filterValue.dimension.order ?? 0;
      const rightDimensionOrder = right.filterValue.dimension.order ?? 0;
      if (leftDimensionOrder !== rightDimensionOrder) {
        return leftDimensionOrder - rightDimensionOrder;
      }
      return (left.filterValue.order ?? 0) - (right.filterValue.order ?? 0);
    })
    .forEach((row) => {
      const current =
        metadataByEntityId.get(row.entityId) ?? emptyAdminCatalogFilterMetadata();
      current.filterValueIds.push(row.filterValueId);
      current.filters.push({
        dimensionId: row.filterValue.dimension.id,
        dimensionSlug: row.filterValue.dimension.slug,
        dimensionName: row.filterValue.dimension.name,
        valueId: row.filterValue.id,
        valueSlug: row.filterValue.slug,
        valueName: row.filterValue.name,
      });
      metadataByEntityId.set(row.entityId, current);
    });

  return metadataByEntityId;
}
