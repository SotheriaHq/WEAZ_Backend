import { UserHelperService } from './user-helper.service';

describe('UserHelperService', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    brand: { findUnique: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('checks Industri number uniqueness against Brand.industriNumber', async () => {
    const randomSpy = jest
      .spyOn(Math, 'random')
      .mockReturnValueOnce(0.123456789012)
      .mockReturnValueOnce(0.987654321098);

    prisma.brand.findUnique
      .mockResolvedValueOnce({ id: 'existing-brand' })
      .mockResolvedValueOnce(null);

    const service = new UserHelperService(prisma as any);

    await expect(service.generateIndustriNumber()).resolves.toBe(
      'IDT987654321098',
    );

    expect(prisma.brand.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.brand.findUnique).toHaveBeenCalledWith({
      where: { industriNumber: 'IDT123456789012' },
      select: { id: true },
    });
    expect(prisma.brand.findUnique).toHaveBeenCalledWith({
      where: { industriNumber: 'IDT987654321098' },
      select: { id: true },
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();

    randomSpy.mockRestore();
  });
});
