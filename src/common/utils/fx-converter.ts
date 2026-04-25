/**
 * FX Conversion Scaffold
 * ======================
 * Item #15: Foreign Exchange conversion for multi-currency display
 * 
 * CURRENT STATUS: SCAFFOLD / PLACEHOLDER
 * This module provides infrastructure for future currency conversion.
 * Actual rates will be populated from an external FX provider.
 * 
 * PLANNED INTEGRATION:
 * - Connect to FX rate provider (e.g., Open Exchange Rates, CurrencyLayer)
 * - Cache rates with configurable TTL (suggested: 1 hour)
 * - Support for real-time rate updates via Redis pub/sub
 * 
 * SUPPORTED CURRENCIES (Phase 1):
 * - NGN (Nigerian Naira) - Base currency
 * - USD (US Dollar)
 * - GBP (British Pound)
 * - EUR (Euro)
 */

export interface FxRates {
  base: string;
  rates: Record<string, number>;
  timestamp: Date;
  expiresAt: Date;
}

// Placeholder rates - will be replaced with live rates in production
const PLACEHOLDER_RATES: Record<string, number> = {
  NGN: 1,        // Base currency
  USD: 0.00065,  // ~1540 NGN = 1 USD
  GBP: 0.00051,  // ~1960 NGN = 1 GBP
  EUR: 0.00060,  // ~1670 NGN = 1 EUR
  GHS: 0.0081,   // ~123 NGN = 1 GHS (Ghana Cedis)
  KES: 0.0884,   // ~11 NGN = 1 KES (Kenya Shillings)
  ZAR: 0.0118,   // ~85 NGN = 1 ZAR (South African Rand)
};

// Inverse rates for quick conversion from USD to other currencies
const USD_TO_LOCAL: Record<string, number> = {
  NGN: 1540,
  GBP: 0.79,
  EUR: 0.93,
  GHS: 12.5,
  KES: 136,
  ZAR: 18.2,
};

export interface ConversionResult {
  originalAmount: number;
  originalCurrency: string;
  convertedAmount: number;
  targetCurrency: string;
  rate: number;
  isEstimate: boolean;  // True when using placeholder rates
  timestamp: Date;
}

export interface PriceDisplay {
  amount: number;
  currency: string;
  formatted: string;
  localEquivalent?: ConversionResult;
}

/**
 * FX Converter Service (Scaffold)
 * 
 * Currently uses placeholder rates.
 * In production, this will:
 * 1. Fetch rates from external API on startup and periodically
 * 2. Cache rates in Redis for horizontal scaling
 * 3. Emit events when rates change significantly (>1%)
 */
export class FxConverter {
  private rates: FxRates;
  private static instance: FxConverter | null = null;

  constructor() {
    // Initialize with placeholder rates
    const now = new Date();
    this.rates = {
      base: 'NGN',
      rates: { ...PLACEHOLDER_RATES },
      timestamp: now,
      expiresAt: new Date(now.getTime() + 3600000), // 1 hour TTL
    };
  }

  /**
   * Get singleton instance
   */
  static getInstance(): FxConverter {
    if (!FxConverter.instance) {
      FxConverter.instance = new FxConverter();
    }
    return FxConverter.instance;
  }

  /**
   * Convert amount from one currency to another
   */
  convert(
    amount: number,
    fromCurrency: string,
    toCurrency: string,
  ): ConversionResult {
    const from = fromCurrency.toUpperCase();
    const to = toCurrency.toUpperCase();

    if (from === to) {
      return {
        originalAmount: amount,
        originalCurrency: from,
        convertedAmount: amount,
        targetCurrency: to,
        rate: 1,
        isEstimate: false,
        timestamp: new Date(),
      };
    }

    // Convert to NGN first (base), then to target
    const toNgnRate = 1 / (this.rates.rates[from] || 1);
    const fromNgnRate = this.rates.rates[to] || 1;
    const finalRate = toNgnRate * fromNgnRate;
    const convertedAmount = Math.round(amount * finalRate * 100) / 100;

    return {
      originalAmount: amount,
      originalCurrency: from,
      convertedAmount,
      targetCurrency: to,
      rate: finalRate,
      isEstimate: true, // Always true until live rates are integrated
      timestamp: this.rates.timestamp,
    };
  }

  /**
   * Convert NGN price to user's preferred currency
   */
  convertFromNgn(amountNgn: number, toCurrency: string): ConversionResult {
    return this.convert(amountNgn, 'NGN', toCurrency);
  }

  /**
   * Convert price to NGN from any currency
   */
  convertToNgn(amount: number, fromCurrency: string): ConversionResult {
    return this.convert(amount, fromCurrency, 'NGN');
  }

  /**
   * Format price for display with optional local equivalent
   */
  formatPrice(
    amount: number,
    currency: string,
    userCurrency?: string,
  ): PriceDisplay {
    const curr = currency.toUpperCase();
    let formatted: string;

    try {
      formatted = new Intl.NumberFormat('en-NG', {
        style: 'currency',
        currency: curr,
        maximumFractionDigits: curr === 'NGN' ? 0 : 2,
      }).format(amount);
    } catch {
      // Fallback for unsupported currencies
      formatted = `${curr} ${amount.toLocaleString()}`;
    }

    const result: PriceDisplay = {
      amount,
      currency: curr,
      formatted,
    };

    // Add local equivalent if user currency differs
    if (userCurrency && userCurrency.toUpperCase() !== curr) {
      result.localEquivalent = this.convert(amount, curr, userCurrency);
    }

    return result;
  }

  /**
   * Format price range (e.g., for collections)
   */
  formatPriceRange(
    minPrice: number | null,
    maxPrice: number | null,
    currency: string,
    userCurrency?: string,
  ): { formatted: string; localEquivalent?: string } {
    const curr = currency.toUpperCase();

    if (!minPrice && !maxPrice) {
      return { formatted: 'Price not set' };
    }

    const formatSingle = (val: number) => {
      try {
        return new Intl.NumberFormat('en-NG', {
          style: 'currency',
          currency: curr,
          maximumFractionDigits: curr === 'NGN' ? 0 : 2,
        }).format(val);
      } catch {
        return `${curr} ${val.toLocaleString()}`;
      }
    };

    let formatted: string;
    if (minPrice && maxPrice && minPrice !== maxPrice) {
      formatted = `${formatSingle(minPrice)} - ${formatSingle(maxPrice)}`;
    } else {
      formatted = formatSingle(minPrice || maxPrice || 0);
    }

    const result: { formatted: string; localEquivalent?: string } = { formatted };

    // Add local equivalent
    if (userCurrency && userCurrency.toUpperCase() !== curr) {
      const minConverted = minPrice
        ? this.convert(minPrice, curr, userCurrency).convertedAmount
        : null;
      const maxConverted = maxPrice
        ? this.convert(maxPrice, curr, userCurrency).convertedAmount
        : null;

      const formatLocal = (val: number) => {
        const uc = userCurrency.toUpperCase();
        try {
          return new Intl.NumberFormat('en-NG', {
            style: 'currency',
            currency: uc,
            maximumFractionDigits: uc === 'NGN' ? 0 : 2,
          }).format(val);
        } catch {
          return `${uc} ${val.toLocaleString()}`;
        }
      };

      if (minConverted && maxConverted && minConverted !== maxConverted) {
        result.localEquivalent = `≈ ${formatLocal(minConverted)} - ${formatLocal(maxConverted)}`;
      } else {
        result.localEquivalent = `≈ ${formatLocal(minConverted || maxConverted || 0)}`;
      }
    }

    return result;
  }

  /**
   * Get current rates (for debugging/admin)
   */
  getRates(): FxRates {
    return { ...this.rates };
  }

  /**
   * Check if rates need refresh
   */
  needsRefresh(): boolean {
    return new Date() > this.rates.expiresAt;
  }

  /**
   * PLACEHOLDER: Refresh rates from external provider
   * This will be implemented when FX integration is complete
   */
  async refreshRates(): Promise<void> {
    // TODO: Implement actual API call
    // const response = await fetch('https://api.exchangerate-api.com/v4/latest/NGN');
    // const data = await response.json();
    // this.rates.rates = data.rates;
    // this.rates.timestamp = new Date();
    // this.rates.expiresAt = new Date(Date.now() + 3600000);
    
    console.log('[FxConverter] Rate refresh not yet implemented - using placeholder rates');
    this.rates.timestamp = new Date();
    this.rates.expiresAt = new Date(Date.now() + 3600000);
  }
}

// Export singleton getter for easy use
export const getFxConverter = () => FxConverter.getInstance();

// Export supported currencies list
export const SUPPORTED_CURRENCIES = Object.keys(PLACEHOLDER_RATES);

// Default export
export default FxConverter;
