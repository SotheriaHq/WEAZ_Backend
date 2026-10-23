/** Prisma DateTime columns store UTC timestamp values without a time-zone suffix. */
export function withUtcDatabaseUrl(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL.');
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL.');
  }
  // The URL's options override pg.Pool options. Preserve other startup settings,
  // then apply UTC last so a URL or PGOPTIONS cannot silently restore local time.
  const options = url.searchParams.get('options') || process.env.PGOPTIONS || '';
  url.searchParams.set('options', `${options.trim()} -c timezone=UTC`.trim());
  return url.toString();
}
