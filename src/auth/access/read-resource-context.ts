import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ContentTarget } from 'src/common/content-audience';

export type FileReadSource = { type: 'DESIGN' | 'COLLECTION' | 'PRODUCT'; id: string; viewer?: string;
  allowDeletedByOwner?: boolean };
export type AuthorizedDisplayFile = { fileId: string; source: FileReadSource };
export type FileReadResource = { type: 'FILE'; id: string; viewer?: string; role?: string;
  publicOnly: boolean; key: string; assetVersion: number; variantKey?: string; expectedFileType?: string;
  source?: FileReadSource; privateCollectionsEnabled: boolean };
export type ReadResource = { type: ContentTarget | 'STORE_COLLECTION'; id: string; viewer?: string;
  allowDeletedByOwner?: boolean } | FileReadResource;
export type ReadResourceScope = { open: boolean; resources: Map<string, ReadResource>;
  actor?: Readonly<{ id: string; role?: string }> };
export const readResourceContext = new AsyncLocalStorage<ReadResourceScope>();

/** Domain authorizers register only successful decisions, only inside the
 * current read. No database clients, callbacks or private bodies are retained. */
export function rememberReadResource(resource: ReadResource): void {
  const scope = readResourceContext.getStore();
  if (!scope) return;
  if (!scope.open) throw new ConflictException('This request ended. Start it again.');
  const key = resource.type === 'FILE'
    ? JSON.stringify([resource.type, resource.id, resource.viewer, resource.role, resource.publicOnly,
      resource.key, resource.assetVersion, resource.variantKey, resource.expectedFileType, resource.privateCollectionsEnabled,
      resource.source?.type, resource.source?.id, resource.source?.viewer, resource.source?.allowDeletedByOwner === true])
    : JSON.stringify([resource.type, resource.id, resource.viewer, resource.allowDeletedByOwner === true]);
  if (!scope.resources.has(key) && scope.resources.size >= 1024)
    throw new ServiceUnavailableException('Too many access constraints in one response. Request a smaller page.');
  scope.resources.set(key, resource.type === 'FILE'
    ? Object.freeze({ ...resource, source: resource.source ? Object.freeze({ ...resource.source }) : undefined })
    : Object.freeze({ ...resource }));
}
