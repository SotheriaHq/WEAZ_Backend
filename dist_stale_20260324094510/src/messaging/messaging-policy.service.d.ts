import { CustomOrderStatus, MessageContextType, MessageThreadStatus, OrderStatus, Prisma } from '@prisma/client';
export declare class MessagingPolicyService {
    private readonly customOrderWritable;
    private readonly standardOrderWritable;
    resolveThreadStatusForCustomOrder(status: CustomOrderStatus): MessageThreadStatus;
    resolveThreadStatusForOrder(status: OrderStatus): MessageThreadStatus;
    assertCanSend(status: MessageThreadStatus): void;
    buildContextFilter(contextType: MessageContextType, contextId: string): Prisma.MessageThreadWhereInput;
}
