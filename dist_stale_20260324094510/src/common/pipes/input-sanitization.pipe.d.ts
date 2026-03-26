import { ArgumentMetadata, PipeTransform } from '@nestjs/common';
export declare class InputSanitizationPipe implements PipeTransform {
    transform(value: unknown, metadata: ArgumentMetadata): unknown;
}
