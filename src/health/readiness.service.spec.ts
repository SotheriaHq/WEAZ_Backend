import { ReadinessService } from './readiness.service';

describe('ReadinessService', () => {
  const prisma = {
    $queryRaw: jest.fn(),
  };
  const paymentRuntimeHealth = {
    getRuntimeHealth: jest.fn(),
  };

  let service: ReadinessService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReadinessService(prisma as any, paymentRuntimeHealth as any);
  });

  it('returns ready when all checks pass', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    paymentRuntimeHealth.getRuntimeHealth.mockResolvedValue({
      redis: { ready: true, pingMs: 2, error: null },
      worker: {
        seen: true,
        stale: false,
        lastHeartbeatAt: new Date().toISOString(),
        ageSeconds: 5,
        maxAgeSeconds: 120,
        metadata: null,
      },
    });

    const result = await service.getReadiness();

    expect(result.status).toBe('ready');
    expect(result.checks).toHaveLength(3);
    expect(result.checks.every((check) => check.ok)).toBe(true);
  });

  it('returns degraded when redis is unavailable', async () => {
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);
    paymentRuntimeHealth.getRuntimeHealth.mockResolvedValue({
      redis: { ready: false, pingMs: null, error: 'Redis down' },
      worker: {
        seen: true,
        stale: false,
        lastHeartbeatAt: new Date().toISOString(),
        ageSeconds: 5,
        maxAgeSeconds: 120,
        metadata: null,
      },
    });

    const result = await service.getReadiness();

    expect(result.status).toBe('degraded');
    expect(result.checks.find((check) => check.name === 'redis')?.ok).toBe(false);
  });
});