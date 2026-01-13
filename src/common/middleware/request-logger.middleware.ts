import { Logger } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import type { NextFunction, Request, Response } from 'express';

export function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction) {
  const logger = new Logger('HTTP');

  const existing = req.headers['x-request-id'];
  const requestId = (typeof existing === 'string' && existing.trim()) || uuidv4();

  (req as any).requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    const method = req.method;
    const path = (req.originalUrl || req.url || '').split('?')[0];
    const status = res.statusCode;

    const msg = JSON.stringify({
      requestId,
      method,
      path,
      status,
      durationMs,
      ip: req.ip,
    });

    if (durationMs >= 2000) {
      logger.warn(msg);
    } else {
      logger.log(msg);
    }
  });

  next();
}
