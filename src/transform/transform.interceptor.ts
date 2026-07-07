import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
  StreamableFile,
} from '@nestjs/common';
import { map, Observable, catchError } from 'rxjs';

@Injectable()
export class TransformInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TransformInterceptor.name);

  private isBinaryResponse(data: unknown, response: unknown): boolean {
    if (data instanceof StreamableFile || Buffer.isBuffer(data)) {
      return true;
    }

    const getHeader =
      response &&
      typeof response === 'object' &&
      'getHeader' in response &&
      typeof (response as { getHeader?: unknown }).getHeader === 'function'
        ? (response as { getHeader: (name: string) => unknown }).getHeader.bind(
            response,
          )
        : null;
    const contentType = String(
      getHeader?.('Content-Type') ?? getHeader?.('content-type') ?? '',
    ).toLowerCase();

    return (
      contentType.startsWith('image/') ||
      contentType.startsWith('video/') ||
      contentType.startsWith('audio/') ||
      contentType === 'application/pdf' ||
      contentType === 'application/octet-stream'
    );
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => {
        try {
          const response = context.switchToHttp().getResponse();

          if (this.isBinaryResponse(data, response)) {
            return data;
          }

          // Don't transform error responses
          if (response.statusCode >= 400) {
            return data;
          }
          if (
            data &&
            typeof data === 'object' &&
            data.hasOwnProperty('message')
          ) {
            // Data is already structured, just add statusCode if missing
            return {
              statusCode: response.statusCode || 200,
              ...data,
            };
          }

          // Safe transformation
          return {
            statusCode: response.statusCode || 200,
            message: data?.message || 'Success',
            data: data,
          };
        } catch (transformError) {
          this.logger.error('Transform interceptor error:', transformError);
          // Return original data if transformation fails
          return data;
        }
      }),
      catchError((error) => {
        // Log but don't crash - let the exception filter handle it
        this.logger.error('Interceptor caught error:', error.message);
        throw error; // Re-throw to let exception filter handle
      }),
    );
  }
}
