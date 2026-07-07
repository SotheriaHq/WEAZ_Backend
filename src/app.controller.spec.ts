import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ReadinessService } from './health/readiness.service';

describe('AppController', () => {
  let appController: AppController;
  const readinessService = {
    getReadiness: jest.fn(),
  };

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: ReadinessService,
          useValue: readinessService,
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
    readinessService.getReadiness.mockReset();
  });

  describe('root', () => {
    it('should return "Hello World!"', () => {
      expect(appController.getHello()).toBe('Hello World!');
    });
  });

  describe('healthz', () => {
    it('should return a render-compatible health payload', () => {
      expect(appController.getHealth()).toEqual({
        status: 'ok',
        service: 'wiez-backend',
        timestamp: expect.any(String),
      });
    });
  });

  describe('ready', () => {
    it('returns 200 when all readiness checks pass', async () => {
      readinessService.getReadiness.mockResolvedValue({
        status: 'ready',
        service: 'wiez-backend',
        timestamp: '2026-07-07T00:00:00.000Z',
        checks: [],
      });

      const res = { status: jest.fn() };
      const payload = await appController.getReady(res as any);

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
      const payload = await appController.getReady(res as any);

      expect(payload.status).toBe('degraded');
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });
});