import * as path from 'path';
import { execFileSync } from 'child_process';

type Route = {
  file: string;
  line: number;
  method: string;
  public: boolean;
  guards: string[];
  skipThrottle: boolean;
  throttle: boolean;
  readOnlyResponse: boolean;
  adminPermissions: string[];
  roles: string[];
  rolesDeclared: boolean;
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

  it('exempts only the no-I/O liveness probe from the shared rate limiter', () => {
    expect(inventory.filter(route => route.skipThrottle).map(route => `${route.file}:${route.method}`))
      .toEqual(['app.controller.ts:getHealth']);
  });

  it('requires authentication for diagnostics even when running in SIT', () => {
    const diagnostics = inventory.filter(route => route.file === 'dev-tools/dev-tools.controller.ts');
    expect(diagnostics).toHaveLength(2);
    for (const route of diagnostics) {
      expect(route.public).toBe(false);
      expect(route.guards).toContain('JwtAuthGuard');
      expect(route.guards).toContain('RolesGuard');
      expect(route.throttle).toBe(true);
    }
  });

  it('never labels an administrator-permission handler as public', () => {
    expect(inventory.filter(route => route.public && (route.adminPermissions.length || route.rolesDeclared))
      .map(route => `${route.file}:${route.line} ${route.method}`)).toEqual([]);
  });

  it('opts only explicit non-mutating POST lookups into response revalidation', () => {
    expect(inventory.filter(route => route.readOnlyResponse).map(route => `${route.file}:${route.method}`).sort())
      .toEqual([
        'admin/jobs/admin-jobs.controller.ts:clockState',
        'dev-tools/dev-tools.controller.ts:extractMetadata',
        'upload/upload.controller.ts:getPublicSignedUrls',
        'upload/upload.controller.ts:getPublicSignedUrlsBySource',
        'upload/upload.controller.ts:getSignedUrlsBySource',
      ].sort());
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

  it('sets explicit budgets for session/device revocation and its security notices', () => {
    for (const method of ['logout', 'logoutAll', 'revokeSecurityDevice', 'revokeSecuritySession', 'logoutOtherSessions', 'revokeDeviceSessions']) {
      const handler = inventory.find(row => row.file === 'auth/auth.controller.ts' && row.method === method);
      expect(handler?.throttle).toBe(true);
    }
  });
});
