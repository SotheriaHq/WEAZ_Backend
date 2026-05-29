import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CustomOrderCheckoutStatus,
  CustomOrderStatus,
  PaymentStatus,
  SizingMode,
} from '@prisma/client';
import type {
  BagDuplicateState,
  CheckoutSessionDuplicateRecord,
  CustomDuplicateClass,
  CustomOrderDuplicateRecord,
  StandardBagValidationInput,
} from './bagging.types';

@Injectable()
export class BagValidationService {
  validateStandardBagInput(input: StandardBagValidationInput) {
    const variants = Array.isArray(input.product.variants)
      ? input.product.variants
      : [];
    const hasVariantSizes = variants.some((variant) => Boolean(variant?.size));
    const hasVariantColors = variants.some((variant) =>
      Boolean(variant?.color),
    );
    const sizes = Array.isArray(input.product.sizes) ? input.product.sizes : [];
    const colors = Array.isArray(input.product.colors)
      ? input.product.colors
      : [];

    if ((hasVariantSizes || sizes.length > 0) && !input.selectedSize) {
      throw new BadRequestException('Please select a size');
    }
    if (input.selectedSize && !sizes.includes(input.selectedSize)) {
      throw new BadRequestException('Invalid size selected');
    }

    if ((hasVariantColors || colors.length > 0) && !input.selectedColor) {
      throw new BadRequestException('Please select a color');
    }
    if (input.selectedColor && !colors.includes(input.selectedColor)) {
      throw new BadRequestException('Invalid color selected');
    }

    const selectedVariant =
      variants.length > 0
        ? variants.find(
            (variant) =>
              (variant?.size || null) === (input.selectedSize || null) &&
              (variant?.color || null) === (input.selectedColor || null),
          )
        : null;

    if (variants.length > 0 && !selectedVariant) {
      throw new BadRequestException('Selected variant is not available');
    }

    if (input.resultingQuantity > 99) {
      throw new BadRequestException(
        'Cart quantity limit exceeded for this item (max 99)',
      );
    }

    if (input.product.trackInventory && !input.product.allowBackorders) {
      if (selectedVariant) {
        const available = Number(selectedVariant.stock || 0);
        if (available < input.resultingQuantity) {
          throw new BadRequestException(
            `Only ${available} items available for the selected variant`,
          );
        }
      } else if (input.selectedSize && input.product.sizeStock) {
        const sizeStock = input.product.sizeStock as Record<string, number>;
        const available = Number(sizeStock[input.selectedSize] || 0);
        if (available < input.resultingQuantity) {
          throw new BadRequestException(
            `Only ${available} items available in size ${input.selectedSize}`,
          );
        }
      } else if (
        Number(input.product.totalStock || 0) < input.resultingQuantity
      ) {
        throw new BadRequestException(
          `Only ${Number(input.product.totalStock || 0)} items available`,
        );
      }
    }

    this.validateRtwPlusFittingsPayload(input);
  }

  classifyDuplicateState(input: {
    checkoutSessions?: CheckoutSessionDuplicateRecord[] | null;
    customOrders?: CustomOrderDuplicateRecord[] | null;
    completedPolicy?: 'ALLOW_REPEAT' | 'BLOCK_REPEAT' | 'UNKNOWN';
  }): BagDuplicateState {
    const classifications: CustomDuplicateClass[] = [];
    const checkoutSessions = Array.isArray(input.checkoutSessions)
      ? input.checkoutSessions
      : [];
    const customOrders = Array.isArray(input.customOrders)
      ? input.customOrders
      : [];

    if (checkoutSessions.some((session) => !session.customOrderId)) {
      classifications.push('IN_BAG');
    }

    if (
      checkoutSessions.some(
        (session) =>
          session.customOrderId &&
          session.status !== CustomOrderCheckoutStatus.PAID_CONFIRMED,
      ) ||
      customOrders.some(
        (order) =>
          order.paymentStatus !== PaymentStatus.PAID &&
          !this.isCompletedOrClosed(order.status),
      )
    ) {
      classifications.push('SUBMITTED_UNPAID');
    }

    if (
      customOrders.some(
        (order) =>
          order.paymentStatus === PaymentStatus.PAID &&
          !this.isCompletedOrClosed(order.status),
      )
    ) {
      classifications.push('PAID_ACTIVE');
    }

    if (
      customOrders.some((order) => order.status === CustomOrderStatus.COMPLETED)
    ) {
      classifications.push(
        input.completedPolicy === 'BLOCK_REPEAT'
          ? 'COMPLETED_BLOCKED'
          : 'COMPLETED_ALLOWED',
      );
    }

    if (classifications.length === 0) {
      classifications.push('UNKNOWN');
    }

    const unique = Array.from(new Set(classifications));

    return {
      inBag: unique.includes('IN_BAG'),
      submittedUnpaid: unique.includes('SUBMITTED_UNPAID'),
      paidActive: unique.includes('PAID_ACTIVE'),
      completedPolicy: input.completedPolicy ?? 'ALLOW_REPEAT',
      reason: this.reasonForClassifications(unique),
      classifications: unique,
    };
  }

  private validateRtwPlusFittingsPayload(input: StandardBagValidationInput) {
    const sizingMode = this.normalizeSizingMode(
      input.sizingMode ?? input.product.sizingMode,
    );
    if (sizingMode !== SizingMode.RTW_PLUS_FITTINGS) return;

    const productRequiredKeys = this.normalizeKeys(
      input.product.customMeasurementKeys,
    );
    const requestedKeys = this.normalizeKeys(input.requiredMeasurementKeys);
    const requiredMeasurementKeys =
      requestedKeys.length > 0
        ? requestedKeys.filter((key) => productRequiredKeys.includes(key))
        : productRequiredKeys;

    if (requiredMeasurementKeys.length === 0) return;

    const providedKeys = this.extractProvidedMeasurementKeys(
      input.sizeFitData ?? null,
    );
    const missingKeys = requiredMeasurementKeys.filter(
      (key) => !providedKeys.includes(key),
    );
    if (missingKeys.length > 0) {
      throw new BadRequestException(
        `Missing required measurements for ${input.product.name || 'product'}: ${missingKeys.join(', ')}`,
      );
    }
  }

  private normalizeSizingMode(value?: string | null): SizingMode {
    if (value === 'RTW_PLUS_CUSTOM') return SizingMode.RTW_PLUS_FITTINGS;
    if (value && Object.values(SizingMode).includes(value as SizingMode)) {
      return value as SizingMode;
    }
    return SizingMode.NONE;
  }

  private normalizeKeys(raw?: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return Array.from(
      new Set(
        raw
          .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
          .filter(Boolean),
      ),
    );
  }

  private extractProvidedMeasurementKeys(
    sizeFitData: Record<string, unknown> | null,
  ): string[] {
    if (!sizeFitData) return [];
    const measurements =
      sizeFitData.measurements &&
      typeof sizeFitData.measurements === 'object' &&
      !Array.isArray(sizeFitData.measurements)
        ? (sizeFitData.measurements as Record<string, unknown>)
        : null;

    const source = measurements ?? sizeFitData;
    return Object.keys(source).filter((key) => {
      const value = source[key];
      if (value == null) return false;
      if (typeof value === 'number') return Number.isFinite(value);
      if (typeof value === 'object' && value !== null) {
        const numericValue = (value as Record<string, unknown>).value;
        return (
          typeof numericValue === 'number' && Number.isFinite(numericValue)
        );
      }
      return false;
    });
  }

  private isCompletedOrClosed(status: CustomOrderStatus): boolean {
    const terminalStatuses: CustomOrderStatus[] = [
      CustomOrderStatus.COMPLETED,
      CustomOrderStatus.CLOSED,
      CustomOrderStatus.REJECTED_BY_BRAND,
      CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
    ];
    return terminalStatuses.includes(status);
  }

  private reasonForClassifications(
    classifications: CustomDuplicateClass[],
  ): string | null {
    if (classifications.includes('IN_BAG'))
      return 'CUSTOM_ORDER_DUPLICATE_IN_BAG';
    if (classifications.includes('SUBMITTED_UNPAID'))
      return 'CUSTOM_ORDER_SUBMITTED_UNPAID_DUPLICATE';
    if (classifications.includes('PAID_ACTIVE'))
      return 'CUSTOM_ORDER_PAID_ACTIVE_DUPLICATE';
    if (classifications.includes('COMPLETED_BLOCKED'))
      return 'CUSTOM_ORDER_COMPLETED_DUPLICATE';
    return null;
  }
}
