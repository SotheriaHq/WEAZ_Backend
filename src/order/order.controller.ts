import { Controller, Get, Param, Patch, Query, Req, UseGuards, Body, BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { UserTypeGuard } from '../auth/guard/user-type.guard';
import { UserType, OrderStatus } from '@prisma/client';

@Controller('brands/:brandId/orders')
@UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
export class OrderController {
    constructor(private readonly orderService: OrderService) { }

    @Get()
    async findAll(
        @Param('brandId') brandId: string,
        @Req() req: any,
        @Query('page') page?: string,
        @Query('limit') limit?: string,
        @Query('status') status?: OrderStatus,
        @Query('q') search?: string,
    ) {
        if (req.user.id !== brandId) {
            throw new BadRequestException('Not authorized for this brand');
        }
        return this.orderService.findAll(
            brandId,
            page ? parseInt(page, 10) : 1,
            limit ? parseInt(limit, 10) : 20,
            status,
            search,
        );
    }

    @Get(':orderId')
    async findOne(
        @Param('brandId') brandId: string,
        @Param('orderId') orderId: string,
        @Req() req: any,
    ) {
        if (req.user.id !== brandId) {
            throw new BadRequestException('Not authorized for this brand');
        }
        return this.orderService.findOne(brandId, orderId);
    }

    @Patch(':orderId/status')
    async updateStatus(
        @Param('brandId') brandId: string,
        @Param('orderId') orderId: string,
        @Body() body: { status: OrderStatus },
        @Req() req: any,
    ) {
        if (req.user.id !== brandId) {
            throw new BadRequestException('Not authorized for this brand');
        }
        return this.orderService.updateStatus(brandId, orderId, body.status);
    }
}
