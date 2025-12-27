// Register runtime module aliases only in production (compiled JS)
// to support absolute imports like 'src/...'
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
import * as cookieParser from 'cookie-parser';
import * as bodyParser from 'body-parser';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

const DEFAULT_BODY_LIMIT = '10mb';
const DEFAULT_PORT = 3040;
const DEFAULT_HOST = '0.0.0.0';

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

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  try {
    const app = await NestFactory.create(AppModule);
    const configService = app.get(ConfigService);

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
        disableErrorMessages: false,
        stopAtFirstError: false,
        exceptionFactory: (errors) => {
          try {
            const formattedErrors = errors.map((error) => {
              const constraints = error.constraints || {};
              return {
                property: error.property || 'unknown',
                value: error.value,
                constraints: Object.values(constraints),
                messages: Object.values(constraints),
              };
            });

            try {
              logger.warn(
                'Validation errors:',
                JSON.stringify(formattedErrors, null, 2),
              );
            } catch (logError) {
              logger.warn('Validation failed (details could not be logged).');
            }

            return new BadRequestException({
              message: 'Validation failed',
              errors: formattedErrors,
              statusCode: 400,
            });
          } catch (factoryError) {
            logger.error('Validation exception factory failed:', factoryError);
            return new BadRequestException('Validation failed');
          }
        },
      }),
    );

    const swaggerConfig = new DocumentBuilder()
      .setTitle('voguely API')
      .setDescription('API documentation for voguely')
      .setVersion('1.0')
      .addTag('voguely')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api', app, document);

    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new TransformInterceptor());

    const corsOriginsRaw = configService.get<string>(
      'CORS_ALLOWED_ORIGINS',
      '',
    );
    const allowedOrigins = corsOriginsRaw
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);

    // Always allow localhost development origins
    if (!allowedOrigins.includes('http://localhost:3000')) {
      allowedOrigins.push('http://localhost:3000');
    }
    if (!allowedOrigins.includes('http://localhost:5173')) {
      allowedOrigins.push('http://localhost:5173');
    }

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
    // Always allow idempotency/client event headers used by the frontend
    ['x-client-event-id', 'x-request-id'].forEach((h) =>
      allowedHeadersSet.add(h),
    );
    const allowedHeaders = Array.from(allowedHeadersSet).join(', ');

    app.enableCors({
      origin: allowedOrigins.length > 0 ? allowedOrigins : true,
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
      }),
    );
    app.use(
      bodyParser.urlencoded({
        extended: true,
        limit: configService.get<string>('BODY_LIMIT', DEFAULT_BODY_LIMIT),
      }),
    );

    const port = parsePort(configService.get<string>('APP_PORT'));
    const host = configService.get<string>('APP_HOST', DEFAULT_HOST);

    await app.listen(port, host);
    logger.log(`Application is running on: http://${host}:${port}`);

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
    logger.error('Failed to start application:', error);
    process.exit(1);
  }

  process.on('uncaughtException', (error) => {
    logger.error(
      'Uncaught exception; application will continue running:',
      error,
    );
  });

  process.on('unhandledRejection', (reason, promise) => {
    logger.error(
      'Unhandled promise rejection; application will continue running:',
      { promise, reason },
    );
  });

  process.on('warning', (warning) => {
    logger.warn('Process warning:', warning.message);
  });
}

bootstrap().catch((error) => {
  const logger = new Logger('Bootstrap');
  logger.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
