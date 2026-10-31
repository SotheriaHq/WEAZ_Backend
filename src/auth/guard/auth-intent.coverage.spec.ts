import * as path from 'path';
import { execFileSync } from 'child_process';

type Route = {
  file: string;
  line: number;
  method: string;
  public: boolean;
  guards: string[];
};

/** Parse actual TypeScript decorators, including multiline/class-level guards. */
describe('HTTP authentication policy coverage', () => {
  const inventory = JSON.parse(
    execFileSync(
      process.execPath,
      [path.resolve(__dirname, '../../../scripts/audit-endpoint-security.cjs')],
      { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 },
    ),
  ) as Route[];

  it('inspects every current HTTP handler', () => {
    expect(inventory.length).toBeGreaterThanOrEqual(825);
  });

  it('requires explicit public access or a recognised authentication guard', () => {
    const offenders = inventory.filter(
      (route) =>
        !route.public &&
        !route.guards.some(
          (name) =>
            ['JwtAuthGuard', 'OptionalJwtAuthGuard'].includes(name) ||
            /^AuthGuard\(['"]jwt['"]\)$/.test(name),
        ),
    );
    expect(offenders.map((r) => `${r.file}:${r.line} ${r.method}`)).toEqual([]);
  });

  it('keeps signup dependencies and entry points explicitly public', () => {
    for (const method of [
      'login',
      'create',
      'googleAuth',
      'refresh',
      'verifyEmailByCode',
    ]) {
      expect(
        inventory.find(
          (r) => r.file === 'auth/auth.controller.ts' && r.method === method,
        )?.public,
      ).toBe(true);
    }
    expect(
      inventory.find(
        (r) =>
          r.file === 'legal/legal.controller.ts' && r.method === 'getVersions',
      )?.public,
    ).toBe(true);
  });
});
