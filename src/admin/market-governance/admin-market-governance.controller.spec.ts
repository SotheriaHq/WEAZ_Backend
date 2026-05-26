import 'reflect-metadata';
import { Role } from '@prisma/client';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import {
  ADMIN_PERMISSIONS_KEY,
} from '../decorators/require-permissions.decorator';
import { AdminMarketGovernanceController } from './admin-market-governance.controller';

describe('AdminMarketGovernanceController', () => {
  const getPermissions = (methodName: keyof AdminMarketGovernanceController) =>
    Reflect.getMetadata(
      ADMIN_PERMISSIONS_KEY,
      AdminMarketGovernanceController.prototype[methodName],
    );

  it('is limited to Admin and SuperAdmin roles', () => {
    expect(Reflect.getMetadata('roles', AdminMarketGovernanceController)).toEqual([
      Role.SuperAdmin,
      Role.Admin,
    ]);
  });

  it('requires read permission for read-only governance endpoints', () => {
    for (const methodName of [
      'listSections',
      'listRankingProfiles',
      'listRankingFormulas',
      'listSuggestionBlocks',
      'listAuditLogs',
      'getReleaseStatus',
    ] as const) {
      expect(getPermissions(methodName)).toEqual([
        ADMIN_PERMISSIONS.MARKET_GOVERNANCE_READ,
      ]);
    }
  });

  it('requires write permissions for mutable governance endpoints', () => {
    expect(getPermissions('patchSection')).toEqual([
      ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE,
    ]);
    expect(getPermissions('createRankingProfile')).toEqual([
      ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE,
    ]);
    expect(getPermissions('patchRankingProfile')).toEqual([
      ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE,
    ]);
    expect(getPermissions('createRankingFormula')).toEqual([
      ADMIN_PERMISSIONS.MARKET_RANKING_FORMULA_WRITE,
    ]);
    expect(getPermissions('createSuggestionBlock')).toEqual([
      ADMIN_PERMISSIONS.MARKET_SUGGESTIONS_WRITE,
    ]);
    expect(getPermissions('patchSuggestionBlock')).toEqual([
      ADMIN_PERMISSIONS.MARKET_SUGGESTIONS_WRITE,
    ]);
  });

  it('requires explicit release permissions for rollback operations', () => {
    expect(getPermissions('rollbackRanking')).toEqual([
      ADMIN_PERMISSIONS.MARKET_RANKING_ROLLBACK,
    ]);
    expect(getPermissions('rehearseRollback')).toEqual([
      ADMIN_PERMISSIONS.MARKET_GOVERNANCE_RELEASE,
    ]);
  });
});

describe('AdminPermissionGuard market governance behavior', () => {
  const reflector = {
    getAllAndOverride: jest.fn(),
  };
  const context = (user: unknown) =>
    ({
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => ({ user }),
      }),
    }) as any;

  beforeEach(() => {
    reflector.getAllAndOverride.mockReturnValue([
      ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE,
    ]);
  });

  it('allows SuperAdmin without explicit permission grants', () => {
    const guard = new AdminPermissionGuard(reflector as any);

    expect(guard.canActivate(context({ role: Role.SuperAdmin }))).toBe(true);
  });

  it('allows Admin with an explicit market governance grant', () => {
    const guard = new AdminPermissionGuard(reflector as any);

    expect(
      guard.canActivate(
        context({
          role: Role.Admin,
          permissions: [ADMIN_PERMISSIONS.MARKET_GOVERNANCE_WRITE],
        }),
      ),
    ).toBe(true);
  });

  it('rejects Admin without an explicit market governance grant', () => {
    const guard = new AdminPermissionGuard(reflector as any);

    expect(() =>
      guard.canActivate(context({ role: Role.Admin, permissions: [] })),
    ).toThrow('Insufficient admin permissions');
  });

  it('rejects unauthenticated requests', () => {
    const guard = new AdminPermissionGuard(reflector as any);

    expect(() => guard.canActivate(context(undefined))).toThrow(
      'Authentication required',
    );
  });
});
