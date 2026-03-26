"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLoggerMiddleware = requestLoggerMiddleware;
const common_1 = require("@nestjs/common");
const uuid_1 = require("uuid");
const httpLogger = new common_1.Logger('HTTP');
function requestLoggerMiddleware(req, res, next) {
    const existing = req.headers['x-request-id'];
    const requestId = (typeof existing === 'string' && existing.trim()) || (0, uuid_1.v4)();
    req.requestId = requestId;
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
            httpLogger.warn(msg);
        }
        else {
            httpLogger.log(msg);
        }
    });
    next();
}
//# sourceMappingURL=request-logger.middleware.js.map