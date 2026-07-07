import { Test, TestingModule } from '@nestjs/testing';
import { ReadinessController } from './readiness.controller';
import { ReadinessService } from './readiness.service';

describe('ReadinessController', () => {
  let controller: ReadinessController;
  const readinessService = {
    getReadiness: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReadinessController],
      providers: [
        {
          provide: ReadinessService,
          useValue: readinessService,
        },
      ],
    }).compile();

    controller = module.get(ReadinessController);
    readinessService.getReadiness.mockReset();
  });

  it('returns 200 when all readiness checks pass', async () => {
    readinessService.getReadiness.mockResolvedValue({
      status: 'ready',
      service: 'wiez-backend',
      timestamp: '2026-07-07T00:00:00.000Z',
      checks: [],
    });

    const res = { status: jest.fn() };
    const payload = await controller.getReady(res as any);

    expect(payload.status).toBe('ready');
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 503 when readiness is degraded', async () => {
    readinessService.getReadiness.mockResolvedValue({
      status: 'degraded',
      service: 'wiez-backend',
      timestamp: '2026-07-07T00:00:00.000Z',
      checks: [{ name: 'worker', ok: false, latencyMs: null, detail: 'stale' }],
    });

    const res = { status: jest.fn() };
    const payload = await controller.getReady(res as any);

    expect(payload.status).toBe('degraded');
    expect(res.status).toHaveBeenCalledWith(503);
  });
});