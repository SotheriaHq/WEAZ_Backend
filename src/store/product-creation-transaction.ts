/** Retry only a Product.slug conflict, after the entire attempt has rolled back. */
export function isProductSlugConflict(error: unknown): boolean {
  const failure = error as {
    code?: string;
    meta?: {
      modelName?: string;
      target?: string | string[];
      driverAdapterError?: {
        cause?: { constraint?: { fields?: string[]; index?: string } };
      };
    };
  } | null;
  if (failure?.code !== 'P2002') return false;
  if (failure.meta?.modelName && failure.meta.modelName !== 'Product')
    return false;
  const target = failure.meta?.target;
  if (Array.isArray(target)) return target.length === 1 && target[0] === 'slug';
  if (typeof target === 'string') return target === 'Product_slug_key';
  const constraint = failure.meta?.driverAdapterError?.cause?.constraint;
  return (
    (constraint?.fields?.length === 1 && constraint.fields[0] === 'slug') ||
    constraint?.index === 'Product_slug_key'
  );
}

export async function retryProductCreation<T>(
  operation: (attempt: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= 2 || !isProductSlugConflict(error)) throw error;
    }
  }
}
