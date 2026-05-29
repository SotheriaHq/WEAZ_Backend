import { ArgumentMetadata, Injectable, PipeTransform } from '@nestjs/common';
import { sanitizeRequestInput } from 'src/common/utils/input-sanitizer';

@Injectable()
export class InputSanitizationPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (!value) return value;
    if (
      metadata.type !== 'body' &&
      metadata.type !== 'query' &&
      metadata.type !== 'param'
    ) {
      return value;
    }
    return sanitizeRequestInput(value);
  }
}
