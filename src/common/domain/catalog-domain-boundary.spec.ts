import { readFileSync } from 'fs';
import { join } from 'path';

const source = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8');

describe('catalog domain boundary contracts', () => {
  it('keeps product DTO collectionId scoped to StoreCollection membership', () => {
    const productDto = source('src/store/dto/create-product.dto.ts');

    expect(productDto).toContain(
      'collectionId means optional StoreCollection membership',
    );
    expect(productDto).not.toMatch(/from ['"].*designs\/dto/);
    expect(productDto).not.toContain('draftSessionToken');
  });

  it('keeps product service out of legacy design initialize/finalize flows', () => {
    const storeService = source('src/store/store.service.ts');

    expect(storeService).not.toMatch(/initializeCollection\s*\(/);
    expect(storeService).not.toMatch(/finalizeCollection\s*\(/);
    expect(storeService).toContain(
      'collectionId is only StoreCollection membership',
    );
  });

  it('documents collection DTO compatibility instead of claiming product ownership', () => {
    const collectionProductsDto = source(
      'src/collections/dto/collection-products.dto.ts',
    );
    const extendedDto = source(
      'src/collections/dto/collection-extended.dto.ts',
    );
    const createCollectionDto = source(
      'src/collections/dto/create-collection.dto.ts',
    );

    expect(collectionProductsDto).toContain('STORE_COLLECTION_GROUPING');
    expect(collectionProductsDto).toContain(
      'do not make collection own product inventory',
    );
    expect(extendedDto).toContain('Collection remains a container');
    expect(createCollectionDto).toContain(
      'LEGACY_COMPAT_COLLECTION_BACKED_DESIGN',
    );
  });
});
