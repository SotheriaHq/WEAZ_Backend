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

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

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
}
