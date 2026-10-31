/**
 * A design is always made to order. Ready-to-wear sizing belongs to products,
 * so these values are written on every design save whatever a client sends.
 * Older app builds still send the fields, which is why the DTOs accept them.
 */
export const designSizingFields = () => ({
  sizingMode: 'CUSTOM' as const,
  rtwSizes: [] as string[],
  rtwSizeSystem: null,
  rtwSizeType: null,
  customOrderEnabled: true,
});

/** The draft row exists but its media never finished uploading. */
export const DRAFT_REASON_UPLOAD_INCOMPLETE = 'UPLOAD_INCOMPLETE';

/** A save that reaches the server means the draft is no longer a failed upload. */
export const clearUploadIncomplete = (draftReason: string | null) =>
  draftReason === DRAFT_REASON_UPLOAD_INCOMPLETE ? { draftReason: null } : {};
