import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Logger,
} from '@nestjs/common';
import { map, Observable, catchError } from 'rxjs';

@Injectable()
export class TransformInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TransformInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      map((data) => {
        try {
          const response = context.switchToHttp().getResponse();

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
