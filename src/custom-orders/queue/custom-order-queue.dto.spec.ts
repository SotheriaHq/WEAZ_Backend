import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CustomOrderPricePreviewDto } from '../dto/custom-orders.dto';
import { QueueSettingsDto } from './custom-order-queue.dto';
describe('literal queue opt-in booleans', () => {
  it.each(['true', 'false', 1, 0])('rejects coerced paid priority selection %p', async value => {
    const dto = plainToInstance(CustomOrderPricePreviewDto, { queueJumpSelected: value }, { enableImplicitConversion: true });
    expect((await validate(dto)).some(error => error.property === 'queueJumpSelected')).toBe(true);
    const settings = plainToInstance(QueueSettingsDto, { queueJumpEnabled: value }, { enableImplicitConversion: true });
    expect((await validate(settings)).some(error => error.property === 'queueJumpEnabled')).toBe(true);
  });
});
