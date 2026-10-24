import { ensureSystemAdmin } from '../../prisma/seed-system-admin';

describe('system admin bootstrap', () => {
  const originalPassword = process.env.SYSTEM_ADMIN_PASSWORD;
  afterEach(() => {
    if (originalPassword === undefined) delete process.env.SYSTEM_ADMIN_PASSWORD;
    else process.env.SYSTEM_ADMIN_PASSWORD = originalPassword;
  });

  it('requires a securely configured initial password before writing an account', async () => {
    delete process.env.SYSTEM_ADMIN_PASSWORD;
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn() } };
    await expect(ensureSystemAdmin(prisma as any)).rejects.toThrow('Set SYSTEM_ADMIN_PASSWORD securely');
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('preserves an existing admin password, suspension and reset requirement on reseeding', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'admin', role: 'SuperAdmin' }), update: jest.fn() },
      userProfile: { upsert: jest.fn() },
    };
    await expect(ensureSystemAdmin(prisma as any)).resolves.toMatchObject({ id: 'admin', created: false });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses to promote another account that happens to use the configured email', async () => {
    const prisma = {
      user: { findUnique: jest.fn().mockResolvedValue({ id: 'buyer', role: 'User' }), update: jest.fn() },
      userProfile: { upsert: jest.fn() },
    };
    await expect(ensureSystemAdmin(prisma as any)).rejects.toThrow('different account role');
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.userProfile.upsert).not.toHaveBeenCalled();
  });
});
