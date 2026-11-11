import { AdminJobsController } from './admin-jobs.controller';

describe('manual cleanup job environment boundary', () => {
  const original = process.env.APP_ENV;
  afterEach(() => { if (original === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = original; });
  it.each(['local', 'development', 'test', 'sit', 'uat'])('permits explicitly configured %s with the existing operator guards', async environment => {
    process.env.APP_ENV = environment;
    const scheduler = { runDraftCleanup: jest.fn().mockResolvedValue({ draftsDeleted: 0 }) };
    const clock = { getEffectiveState: () => ({ mode: 'real' }) };
    const controller = new AdminJobsController(scheduler as any, clock as any);
    expect(await controller.runCollectionDraftExpiry()).toEqual({ triggered: true, summary: { draftsDeleted: 0 } });
    expect(controller.clockState()).toEqual({ mode: 'real' });
  });
  it.each(['production', 'prod', 'unknown', '', undefined])('denies %s without starting the destructive job', async environment => {
    if (environment === undefined) delete process.env.APP_ENV; else process.env.APP_ENV = environment;
    const scheduler = { runDraftCleanup: jest.fn() };
    const controller = new AdminJobsController(scheduler as any, {} as any);
    await expect(controller.runCollectionDraftExpiry()).rejects.toMatchObject({ status: 403 });
    expect(() => controller.clockState()).toThrow('not available');
    expect(scheduler.runDraftCleanup).not.toHaveBeenCalled();
  });
});
