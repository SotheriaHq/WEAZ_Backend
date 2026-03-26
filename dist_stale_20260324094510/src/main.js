"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
try {
    const isTsNode = !!process.env.TS_NODE;
    if (!isTsNode) {
        const req = typeof __non_webpack_require__ === 'function'
            ? __non_webpack_require__
            : require;
        req('module-alias/register');
    }
}
catch { }
const core_1 = require("@nestjs/core");
const app_module_1 = require("./app.module");
const transform_interceptor_1 = require("./transform/transform.interceptor");
const common_1 = require("@nestjs/common");
const All_exception_filter_1 = require("./filters/All-exception.filter");
const cookieParser = require("cookie-parser");
const bodyParser = require("body-parser");
const config_1 = require("@nestjs/config");
const swagger_1 = require("@nestjs/swagger");
const request_logger_middleware_1 = require("./common/middleware/request-logger.middleware");
const input_sanitization_pipe_1 = require("./common/pipes/input-sanitization.pipe");
const express = require("express");
const path_1 = require("path");
const DEFAULT_BODY_LIMIT = '10mb';
const DEFAULT_PORT = 3040;
const DEFAULT_HOST = '0.0.0.0';
const toBoolean = (value, fallback = true) => {
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
const parsePort = (value) => {
    if (!value) {
        return DEFAULT_PORT;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`APP_PORT must be a positive number. Received "${value}".`);
    }
    return parsed;
};
const applyTrustProxy = (app, value) => {
    const expressApp = app.getHttpAdapter().getInstance();
    const setTrustProxy = (trustValue) => {
        if (expressApp && typeof expressApp.set === 'function') {
            expressApp.set('trust proxy', trustValue);
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
const parseOrigin = (origin) => {
    try {
        return new URL(origin);
    }
    catch {
        return null;
    }
};
const isLoopbackHostname = (hostname) => {
    const normalized = hostname.trim().toLowerCase();
    return (normalized === 'localhost' ||
        normalized === '127.0.0.1' ||
        normalized === '::1' ||
        normalized === '[::1]');
};
const isPrivateNetworkHostname = (hostname) => {
    const normalized = hostname.trim().toLowerCase();
    if (!normalized)
        return false;
    if (isLoopbackHostname(normalized))
        return true;
    if (normalized === 'host.docker.internal')
        return true;
    if (/^10\./.test(normalized))
        return true;
    if (/^192\.168\./.test(normalized))
        return true;
    if (/^169\.254\./.test(normalized))
        return true;
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
const isSameLoopbackOrigin = (incomingOrigin, allowedOrigin) => {
    const incoming = parseOrigin(incomingOrigin);
    const allowed = parseOrigin(allowedOrigin);
    if (!incoming || !allowed)
        return false;
    if (!isLoopbackHostname(incoming.hostname) || !isLoopbackHostname(allowed.hostname)) {
        return false;
    }
    const incomingPort = incoming.port || (incoming.protocol === 'https:' ? '443' : '80');
    const allowedPort = allowed.port || (allowed.protocol === 'https:' ? '443' : '80');
    return incoming.protocol === allowed.protocol && incomingPort === allowedPort;
};
async function bootstrap() {
    const logger = new common_1.Logger('Bootstrap');
    try {
        const app = await core_1.NestFactory.create(app_module_1.AppModule);
        const configService = app.get(config_1.ConfigService);
        applyTrustProxy(app, configService.get('TRUST_PROXY', 'false'));
        app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
            res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
            res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
            const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
            if (isSecure) {
                res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
            }
            next();
        });
        app.use(request_logger_middleware_1.requestLoggerMiddleware);
        app.useGlobalPipes(new input_sanitization_pipe_1.InputSanitizationPipe(), new common_1.ValidationPipe({
            whitelist: true,
            forbidNonWhitelisted: true,
            transform: true,
            transformOptions: { enableImplicitConversion: true },
            disableErrorMessages: false,
            stopAtFirstError: false,
            exceptionFactory: (errors) => {
                try {
                    const flattenErrors = (items, parentPath = '') => {
                        const result = [];
                        for (const error of items) {
                            const propertyPath = parentPath
                                ? `${parentPath}.${error.property}`
                                : error.property || 'unknown';
                            const constraints = error.constraints
                                ? Object.values(error.constraints)
                                : [];
                            if (constraints.length > 0) {
                                result.push({
                                    property: propertyPath,
                                    value: error.value,
                                    constraints,
                                    messages: constraints,
                                });
                            }
                            if (Array.isArray(error.children) && error.children.length > 0) {
                                result.push(...flattenErrors(error.children, propertyPath));
                            }
                        }
                        return result;
                    };
                    const formattedErrors = flattenErrors(errors);
                    try {
                        logger.warn('Validation errors:', JSON.stringify(formattedErrors, null, 2));
                    }
                    catch (logError) {
                        logger.warn('Validation failed (details could not be logged).');
                    }
                    return new common_1.BadRequestException({
                        message: 'Validation failed',
                        errors: formattedErrors,
                        statusCode: 400,
                    });
                }
                catch (factoryError) {
                    logger.error('Validation exception factory failed:', factoryError);
                    return new common_1.BadRequestException('Validation failed');
                }
            },
        }));
        const enableSwagger = toBoolean(configService.get('ENABLE_SWAGGER'), false);
        if (enableSwagger) {
            const swaggerConfig = new swagger_1.DocumentBuilder()
                .setTitle('voguely API')
                .setDescription('API documentation for voguely')
                .setVersion('1.0')
                .addTag('voguely')
                .build();
            const document = swagger_1.SwaggerModule.createDocument(app, swaggerConfig);
            swagger_1.SwaggerModule.setup('api', app, document);
        }
        app.useGlobalFilters(new All_exception_filter_1.AllExceptionsFilter());
        app.useGlobalInterceptors(new transform_interceptor_1.TransformInterceptor());
        const corsOriginsRaw = configService.get('CORS_ALLOWED_ORIGINS', '');
        const allowedOrigins = corsOriginsRaw
            .split(',')
            .map((origin) => origin.trim())
            .filter((origin) => origin.length > 0);
        const defaultDevOrigins = [
            'http://localhost:3000',
            'http://localhost:5173',
            'http://localhost:4173',
            'http://localhost:4174',
        ];
        defaultDevOrigins.forEach((origin) => {
            if (!allowedOrigins.includes(origin)) {
                allowedOrigins.push(origin);
            }
        });
        const exposedHeaders = configService
            .get('CORS_EXPOSED_HEADERS', '')
            .trim();
        const envAllowedHeaders = configService.get('CORS_ALLOWED_HEADERS', 'Content-Type, Accept, Authorization');
        const allowedHeadersSet = new Set(envAllowedHeaders
            .split(',')
            .map((h) => h.trim())
            .filter((h) => h.length > 0));
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
        const allowPrivateNetworkCors = toBoolean(configService.get('CORS_ALLOW_PRIVATE_NETWORK'), false);
        app.enableCors({
            origin: (origin, callback) => {
                if (!origin) {
                    callback(null, true);
                    return;
                }
                const incoming = parseOrigin(origin);
                const incomingHost = incoming?.hostname ?? '';
                const isPrivateHost = incomingHost && isPrivateNetworkHostname(incomingHost);
                if (allowPrivateNetworkCors && isPrivateHost) {
                    callback(null, true);
                    return;
                }
                const exactMatch = allowedOrigins.includes(origin);
                const loopbackAliasMatch = allowedOrigins.some((allowedOrigin) => isSameLoopbackOrigin(origin, allowedOrigin));
                if (exactMatch || loopbackAliasMatch) {
                    callback(null, true);
                    return;
                }
                logger.warn(`CORS blocked origin: ${origin}`);
                callback(new Error(`Origin ${origin} is not allowed by CORS`), false);
            },
            methods: configService.get('CORS_ALLOWED_METHODS', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS'),
            credentials: toBoolean(configService.get('CORS_ALLOW_CREDENTIALS'), true),
            allowedHeaders,
            exposedHeaders: exposedHeaders.length > 0 ? exposedHeaders : undefined,
        });
        app.use(cookieParser());
        app.use(bodyParser.json({
            limit: configService.get('BODY_LIMIT', DEFAULT_BODY_LIMIT),
        }));
        app.use(bodyParser.urlencoded({
            extended: true,
            limit: configService.get('BODY_LIMIT', DEFAULT_BODY_LIMIT),
        }));
        const serveLocalUploads = toBoolean(configService.get('SERVE_LOCAL_UPLOADS'), configService.get('NODE_ENV', '').toLowerCase() !== 'production');
        if (serveLocalUploads) {
            app.use('/uploads', express.static((0, path_1.join)(process.cwd(), 'uploads')));
        }
        const port = parsePort(configService.get('APP_PORT'));
        const host = configService.get('APP_HOST', DEFAULT_HOST);
        await app.listen(port, host);
        logger.log(`Application is running on: http://${host}:${port}`);
        void (async () => {
            try {
                const { SystemConfigService } = await Promise.resolve().then(() => require('./admin/system-config/system-config.service'));
                const systemConfigService = app.get(SystemConfigService);
                await systemConfigService.seedDefaults();
            }
            catch (err) {
                logger.warn('SystemConfig seed skipped (non-fatal):', err);
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
    }
    catch (error) {
        logger.error('Failed to start application:', error);
        process.exit(1);
    }
    process.on('uncaughtException', (error) => {
        logger.error('Uncaught exception; application will continue running:', error);
    });
    process.on('unhandledRejection', (reason, promise) => {
        logger.error('Unhandled promise rejection; application will continue running:', { promise, reason });
    });
    process.on('warning', (warning) => {
        logger.warn('Process warning:', warning.message);
    });
}
bootstrap().catch((error) => {
    const logger = new common_1.Logger('Bootstrap');
    logger.error('Fatal error during bootstrap:', error);
    process.exit(1);
});
//# sourceMappingURL=main.js.map