import { ForbiddenException, Injectable } from '@nestjs/common';
import {
  CustomOrderStatus,
  MessageContextType,
  MessageThreadStatus,
  OrderStatus,
  Prisma,
} from '@prisma/client';

@Injectable()
export class MessagingPolicyService {
  private readonly customOrderWritable = new Set<CustomOrderStatus>([
    CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
    CustomOrderStatus.ACCEPTED,
    CustomOrderStatus.IN_PRODUCTION,
    CustomOrderStatus.READY_FOR_DISPATCH,
    CustomOrderStatus.IN_TRANSIT,
    CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
    CustomOrderStatus.DELIVERY_ISSUE_REPORTED,
    CustomOrderStatus.REFUND_IN_PROGRESS,
    CustomOrderStatus.DISPUTED,
  ]);

  private readonly standardOrderWritable = new Set<OrderStatus>([
    OrderStatus.PENDING,
    OrderStatus.PROCESSING,
    OrderStatus.SHIPPED,
  ]);

  resolveThreadStatusForCustomOrder(
    status: CustomOrderStatus,
  ): MessageThreadStatus {
    return this.customOrderWritable.has(status)
      ? MessageThreadStatus.OPEN
      : MessageThreadStatus.READ_ONLY;
  }

  resolveThreadStatusForOrder(status: OrderStatus): MessageThreadStatus {
    return this.standardOrderWritable.has(status)
      ? MessageThreadStatus.OPEN
      : MessageThreadStatus.READ_ONLY;
  }

  assertCanSend(status: MessageThreadStatus) {
    if (status !== MessageThreadStatus.OPEN) {
      throw new ForbiddenException('Thread is read-only');
    }
  }

  buildContextFilter(
    contextType: MessageContextType,
    contextId: string,
  ): Prisma.MessageThreadWhereInput {
    return contextType === MessageContextType.CUSTOM_ORDER
      ? { contextType, customOrderId: contextId }
      : { contextType, orderId: contextId };
  }
}
