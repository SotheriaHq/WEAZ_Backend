/** Retry the complete rolled-back transaction, never external side effects. */
export async function retryDatabaseTransaction<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error: unknown) {
      const failure = error as { code?: string; meta?: { code?: string } };
      const retryable = failure?.code === 'P2034' ||
        ['40001', '40P01'].includes(failure?.code ?? '') ||
        (failure?.code === 'P2010' && ['40001', '40P01'].includes(failure.meta?.code ?? ''));
      if (!retryable || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt + Math.floor(Math.random() * 20)));
    }
  }
}
