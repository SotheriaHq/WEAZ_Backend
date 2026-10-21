/** Bound SQL parameter counts and database pressure while hydrating a result set. */
export async function loadByIds<T extends { id: string }>(
  ids: readonly string[],
  read: (ids: string[]) => Promise<T[]>,
): Promise<Map<string, T>> {
  const unique = [...new Set(ids)];
  const result = new Map<string, T>();
  for (let offset = 0; offset < unique.length; offset += 500) {
    const rows = await read(unique.slice(offset, offset + 500));
    for (const row of rows) result.set(row.id, row);
  }
  return result;
}
