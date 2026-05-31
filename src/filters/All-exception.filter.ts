import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  redactSensitiveLogValue,
  sanitizeErrorForLog,
} from 'src/common/utils/sensitive-log';
import { MonitoringService } from 'src/monitoring/monitoring.service';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  constructor(private readonly monitoring?: MonitoringService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const safePath = request.path || String(request.url ?? '').split('?')[0];
    const isProduction =
      String(process.env.NODE_ENV ?? '')
        .trim()
        .toLowerCase() === 'production';

    let status: number;
    let message: string | object;
    let errors: any = undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const exceptionResponse = exception.getResponse();

      if (typeof exceptionResponse === 'object' && exceptionResponse !== null) {
        // Handle validation errors specifically
        const responseObj = exceptionResponse as any;
        if (isProduction && status >= 500) {
          message = 'Internal server error';
          errors = undefined;
        } else {
          message = redactSensitiveLogValue(
            responseObj.message || 'An error occurred',
          ) as string | object;
          errors = responseObj.errors
            ? redactSensitiveLogValue(responseObj.errors)
            : undefined;
        }
      } else {
        message =
          isProduction && status >= 500
            ? 'Internal server error'
            : exceptionResponse;
      }
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
    }

    this.logger.error(
      `HTTP ${status} - ${request.method} ${safePath}: ${JSON.stringify({
        message,
        ...(errors && { errors }),
      })}`,
      isProduction ? undefined : JSON.stringify(sanitizeErrorForLog(exception)),
    );
    this.emitExceptionAlert(status, request, safePath, exception);

    // Response format
    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: safePath,
      message,
      ...(errors && { errors }),
    };

    response.status(status).json(errorResponse);
  }

  private emitExceptionAlert(
    status: number,
    request: Request,
    path: string,
    exception: unknown,
  ): void {
    if (!this.monitoring) return;
    if (
      status < 500 &&
      status !== HttpStatus.UNAUTHORIZED &&
      status !== HttpStatus.FORBIDDEN
    ) {
      return;
    }

    this.monitoring.emitAlert({
      category:
        status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN
          ? 'SECURITY'
          : 'SYSTEM',
      severity: status >= 500 ? 'error' : 'warning',
      event:
        status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN
          ? 'http_auth_or_permission_failure'
          : 'http_unhandled_failure',
      message:
        status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN
          ? 'HTTP auth or permission failure'
          : 'HTTP unhandled failure',
      metadata: {
        status,
        method: request.method,
        path,
        errorName: exception instanceof Error ? exception.name : 'UnknownError',
      },
    });
  }
}
