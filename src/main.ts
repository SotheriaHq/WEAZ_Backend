// Register runtime module aliases only in production (compiled JS)
// to support absolute imports such as 'src/...'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const __non_webpack_require__: any;
try {
  // Detect if running compiled JS (no ts-node) and dynamically register aliases
  const isTsNode = !!(process as any).env.TS_NODE;
  if (!isTsNode) {
    // Use non-webpack require if available, fallback to require
    const req =
      typeof __non_webpack_require__ === 'function'
        ? __non_webpack_require__
        : require;
    req('module-alias/register');
  }
} catch {}
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TransformInterceptor } from './transform/transform.interceptor';
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from './filters/All-exception.filter';
import cookieParser from 'cookie-parser';
import bodyParser from 'body-parser';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { requestLoggerMiddleware } from './common/middleware/request-logger.middleware';
import { InputSanitizationPipe } from './common/pipes/input-sanitization.pipe';
import { formatValidationErrors } from './common/utils/validation-error-redaction';
import { sanitizeErrorForLog } from './common/utils/sensitive-log';
import { MonitoringService } from './monitoring/monitoring.service';
import * as express from 'express';
import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const DEFAULT_BODY_LIMIT = '10mb';
const DEFAULT_PORT = 3040;
const DEFAULT_HOST = '0.0.0.0';

const rawBodySaver = (
  req: express.Request & { rawBody?: string },
  _res: express.Response,
  buf: Buffer,
) => {
  const path = String(req.originalUrl ?? req.url ?? '');
  if (
    buf.length > 0 &&
    (path.includes('/payment/webhook/') ||
      path.includes('/webhooks/paystack') ||
      path.includes('/webhooks/flutterwave') ||
      path.includes('/admin/payouts/webhook/'))
  ) {
    req.rawBody = buf.toString('utf8');
  }
};

const toBoolean = (value: string | undefined, fallback = true) => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalised = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalised)) {
    return true;
  }
  if (['false', '0', 'no', 'n'].includes(normalised)) {
    return false;
  }
  return fallback;
};

const parsePort = (value: string | undefined) => {
  if (!value) {
    return DEFAULT_PORT;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`APP_PORT must be a positive number. Received "${value}".`);
  }
  return parsed;
};

const resolveOptionalHttpsOptions = (
  env: NodeJS.ProcessEnv = process.env,
): { key: Buffer; cert: Buffer } | undefined => {
  const certPath = String(env.APP_HTTPS_CERT_PATH ?? '').trim();
  const keyPath = String(env.APP_HTTPS_KEY_PATH ?? '').trim();

  if (!certPath && !keyPath) {
    return undefined;
  }

  if (!certPath || !keyPath) {
    throw new Error(
      'APP_HTTPS_CERT_PATH and APP_HTTPS_KEY_PATH must both be set to enable HTTPS.',
    );
  }

  const resolvedCertPath = resolve(process.cwd(), certPath);
  const resolvedKeyPath = resolve(process.cwd(), keyPath);

  if (!existsSync(resolvedCertPath)) {
    throw new Error(
      `APP_HTTPS_CERT_PATH file was not found at ${resolvedCertPath}.`,
    );
  }

  if (!existsSync(resolvedKeyPath)) {
    throw new Error(
      `APP_HTTPS_KEY_PATH file was not found at ${resolvedKeyPath}.`,
    );
  }

  return {
    cert: readFileSync(resolvedCertPath),
    key: readFileSync(resolvedKeyPath),
  };
};

const applyTrustProxy = (
  app: Awaited<ReturnType<typeof NestFactory.create>>,
  value: string | undefined,
) => {
  const expressApp = app.getHttpAdapter().getInstance();
  const setTrustProxy = (trustValue: unknown) => {
    if (expressApp && typeof expressApp.set === 'function') {
      expressApp.set('trust proxy', trustValue as any);
    }
  };
  const raw = (value ?? '').trim().toLowerCase();
  if (!raw || raw === 'false' || raw === '0' || raw === 'no') {
    setTrustProxy(false);
    return;
  }
  if (raw === 'true' || raw === '1' || raw === 'yes') {
    setTrustProxy(1);
    return;
  }
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric >= 0) {
    setTrustProxy(numeric);
    return;
  }
  setTrustProxy(value);
};

const parseOrigin = (origin: string) => {
  try {
    return new URL(origin);
  } catch {
    return null;
  }
};

const isLoopbackHostname = (hostname: string) => {
  const normalized = hostname.trim().toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
};

const isPrivateNetworkHostname = (hostname: string) => {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (isLoopbackHostname(normalized)) return true;
  if (normalized === 'host.docker.internal') return true;

  // Private IPv4 ranges:
  // 10.0.0.0/8
  // 172.16.0.0/12
  // 192.168.0.0/16
  // Link-local 169.254.0.0/16
  if (/^10\./.test(normalized)) return true;
  if (/^192\.168\./.test(normalized)) return true;
  if (/^169\.254\./.test(normalized)) return true;

  const octets = normalized.split('.');
  if (octets.length === 4 && octets.every((part) => /^\d+$/.test(part))) {
    const first = Number(octets[0]);
    const second = Number(octets[1]);
    if (first === 172 && second >= 16 && second <= 31) {
      return true;
    }
  }

  return false;
};

const isSameLoopbackOrigin = (
  incomingOrigin: string,
  allowedOrigin: string,
) => {
  const incoming = parseOrigin(incomingOrigin);
  const allowed = parseOrigin(allowedOrigin);
  if (!incoming || !allowed) return false;

  if (
    !isLoopbackHostname(incoming.hostname) ||
    !isLoopbackHostname(allowed.hostname)
  ) {
    return false;
  }

  const incomingPort =
    incoming.port || (incoming.protocol === 'https:' ? '443' : '80');
  const allowedPort =
    allowed.port || (allowed.protocol === 'https:' ? '443' : '80');

  return incoming.protocol === allowed.protocol && incomingPort === allowedPort;
};

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  try {
    const httpsOptions = resolveOptionalHttpsOptions();
    const app = await NestFactory.create(
      AppModule,
      httpsOptions ? { httpsOptions } : undefined,
    );
    const configService = app.get(ConfigService);
    applyTrustProxy(app, configService.get<string>('TRUST_PROXY', 'false'));

    app.use((req, res, next) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
      res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=()',
      );
      const isSecure =
        req.secure || req.headers['x-forwarded-proto'] === 'https';
      if (isSecure) {
        res.setHeader(
          'Strict-Transport-Security',
          'max-age=31536000; includeSubDomains; preload',
        );
      }
      next();
    });

    app.use(requestLoggerMiddleware);

    app.useGlobalPipes(
      new InputSanitizationPipe(),
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        disableErrorMessages: false,
        stopAtFirstError: false,
        exceptionFactory: (errors) => {
          try {
            const formattedErrors = formatValidationErrors(errors);

            try {
              logger.warn(
                'Validation errors:',
                JSON.stringify(formattedErrors, null, 2),
              );
            } catch {
              logger.warn('Validation failed (details could not be logged).');
            }

            return new BadRequestException({
              message: 'Validation failed',
              errors: formattedErrors,
              statusCode: 400,
            });
          } catch (factoryError) {
            logger.error(
              'Validation exception factory failed:',
              sanitizeErrorForLog(factoryError),
            );
            return new BadRequestException('Validation failed');
          }
        },
      }),
    );

    const enableSwagger = toBoolean(
      configService.get<string>('ENABLE_SWAGGER'),
      false,
    );
    if (enableSwagger) {
      const swaggerConfig = new DocumentBuilder()
        .setTitle('voguely API')
        .setDescription('API documentation for voguely')
        .setVersion('1.0')
        .addTag('voguely')
        .build();
      const document = SwaggerModule.createDocument(app, swaggerConfig);
      SwaggerModule.setup('api', app, document);
    }

    app.useGlobalFilters(
      new AllExceptionsFilter(app.get(MonitoringService, { strict: false })),
    );
    app.useGlobalInterceptors(new TransformInterceptor());

    const corsOriginsRaw = configService.get<string>(
      'CORS_ALLOWED_ORIGINS',
      '',
    );
    const allowedOrigins = corsOriginsRaw
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);

    const defaultDevOrigins = [
      'http://localhost:3000',
      'http://localhost:5173',
      'http://localhost:4173', // Vite preview default
      'http://localhost:4174', // Vite alt preview
    ];

    defaultDevOrigins.forEach((origin) => {
      if (!allowedOrigins.includes(origin)) {
        allowedOrigins.push(origin);
      }
    });

    const exposedHeaders = configService
      .get<string>('CORS_EXPOSED_HEADERS', '')
      .trim();

    const envAllowedHeaders = configService.get<string>(
      'CORS_ALLOWED_HEADERS',
      'Content-Type, Accept, Authorization',
    );
    const allowedHeadersSet = new Set(
      envAllowedHeaders
        .split(',')
        .map((h) => h.trim())
        .filter((h) => h.length > 0),
    );
    // Always allow headers used by the frontend in authenticated and cache-bypass requests.
    [
      'x-client-event-id',
      'x-request-id',
      'idempotency-key',
      'x-idempotency-key',
      'x-confirm-wipe',
      'Cache-Control',
      'Pragma',
      'If-None-Match',
      'If-Modified-Since',
    ].forEach((h) => allowedHeadersSet.add(h));
    const allowedHeaders = Array.from(allowedHeadersSet).join(', ');

    const allowPrivateNetworkCors = toBoolean(
      configService.get<string>('CORS_ALLOW_PRIVATE_NETWORK'),
      false,
    );

    app.enableCors({
      origin: (origin, callback) => {
        if (!origin) {
          callback(null, true);
          return;
        }

        const incoming = parseOrigin(origin);
        const incomingHost = incoming?.hostname ?? '';
        const isPrivateHost =
          incomingHost && isPrivateNetworkHostname(incomingHost);

        // Allow private/loopback origins by default so local preview builds
        // (which often set NODE_ENV=production) keep working.
        if (allowPrivateNetworkCors && isPrivateHost) {
          callback(null, true);
          return;
        }

        const exactMatch = allowedOrigins.includes(origin);
        const loopbackAliasMatch = allowedOrigins.some((allowedOrigin) =>
          isSameLoopbackOrigin(origin, allowedOrigin),
        );

        if (exactMatch || loopbackAliasMatch) {
          callback(null, true);
          return;
        }

        logger.warn(`CORS blocked origin: ${origin}`);
        callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
      },
      methods: configService.get<string>(
        'CORS_ALLOWED_METHODS',
        'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
      ),
      credentials: toBoolean(
        configService.get<string>('CORS_ALLOW_CREDENTIALS'),
        true,
      ),
      allowedHeaders,
      exposedHeaders: exposedHeaders.length > 0 ? exposedHeaders : undefined,
    });

    app.use(cookieParser());
    app.use(
      bodyParser.json({
        limit: configService.get<string>('BODY_LIMIT', DEFAULT_BODY_LIMIT),
        verify: rawBodySaver,
      }),
    );
    app.use(
      bodyParser.urlencoded({
        extended: true,
        limit: configService.get<string>('BODY_LIMIT', DEFAULT_BODY_LIMIT),
        verify: rawBodySaver,
      }),
    );

    const serveLocalUploads = toBoolean(
      configService.get<string>('SERVE_LOCAL_UPLOADS'),
      configService.get<string>('NODE_ENV', '').toLowerCase() !== 'production',
    );
    if (serveLocalUploads) {
      // Serve locally-stored uploads (used as a dev fallback when S3 isn't available).
      app.use('/uploads', express.static(join(process.cwd(), 'uploads')));
    }

    const port = parsePort(configService.get<string>('APP_PORT'));
    const host = configService.get<string>('APP_HOST', DEFAULT_HOST);
    const protocol = httpsOptions ? 'https' : 'http';

    await app.listen(port, host);
    logger.log(`Application is running on: ${protocol}://${host}:${port}`);

    // Seed system config defaults (idempotent) without holding server startup.
    void (async () => {
      try {
        const { SystemConfigService } = await import(
          './admin/system-config/system-config.service'
        );
        const systemConfigService = app.get(SystemConfigService);
        await systemConfigService.seedDefaults();
      } catch (err) {
        logger.warn(
          'SystemConfig seed skipped (non-fatal):',
          sanitizeErrorForLog(err),
        );
      }

      try {
        const { SettlementPolicyService } = await import(
          './finance/settlement-policy.service'
        );
        const settlementPolicyService = app.get(SettlementPolicyService);
        await settlementPolicyService.seedDefaults();
      } catch (err) {
        logger.warn(
          'SettlementPolicy seed skipped (non-fatal):',
          sanitizeErrorForLog(err),
        );
      }
    })();

    process.on('SIGTERM', async () => {
      logger.log('SIGTERM received, shutting down gracefully...');
      await app.close();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.log('SIGINT received, shutting down gracefully...');
      await app.close();
      process.exit(0);
    });
  } catch (error) {
    logger.error('Failed to start application:', sanitizeErrorForLog(error));
    process.exit(1);
  }

  process.on('uncaughtException', (error) => {
    logger.error(
      'Uncaught exception; application will continue running:',
      sanitizeErrorForLog(error),
    );
  });

  process.on('unhandledRejection', (reason) => {
    logger.error(
      'Unhandled promise rejection; application will continue running:',
      sanitizeErrorForLog({ reason }),
    );
  });

  process.on('warning', (warning) => {
    logger.warn('Process warning:', warning.message);
  });
}

bootstrap().catch((error) => {
  const logger = new Logger('Bootstrap');
  logger.error('Fatal error during bootstrap:', sanitizeErrorForLog(error));
  process.exit(1);
});
