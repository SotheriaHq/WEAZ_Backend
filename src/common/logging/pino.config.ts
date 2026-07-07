import type { Params } from 'nestjs-pino';
import type { Request, Response } from 'express';

const isProduction =
  String(process.env.NODE_ENV ?? '')
    .trim()
    .toLowerCase() === 'production';

const throttleEnvironments = new Set(['sit', 'uat', 'production']);

export function shouldEnforceThrottling(): boolean {
  const appEnv = String(process.env.APP_ENV ?? '')
    .trim()
    .toLowerCase();
  if (throttleEnvironments.has(appEnv)) {
    return true;
  }
  return isProduction;
}

export function buildPinoModuleParams(): Params {
  const logLevel = String(process.env.LOG_LEVEL ?? 'info').trim() || 'info';
  const transport = isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          singleLine: true,
          translateTime: 'SYS:standard',
        },
      };

  return {
    pinoHttp: {
      level: logLevel,
      ...(transport ? { transport } : {}),
      autoLogging: false,
      customProps: (req: Request) => {
        const user = (req as Request & { user?: { id?: string; sub?: string; brandId?: string } })
          .user;
        const requestId = String((req as Request & { requestId?: string }).requestId ?? '').trim();
        return {
          requestId: requestId || undefined,
          userId: user?.id ?? user?.sub ?? undefined,
          brandId: user?.brandId ?? undefined,
        };
      },
      serializers: {
        req: (req: Request) => ({
          method: req.method,
          url: req.url,
          ip: req.ip,
        }),
        res: (res: Response) => ({
          statusCode: res.statusCode,
        }),
      },
    },
  };
}