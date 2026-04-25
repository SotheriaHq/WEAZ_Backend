export interface FxRates {
    base: string;
    rates: Record<string, number>;
    timestamp: Date;
    expiresAt: Date;
}
export interface ConversionResult {
    originalAmount: number;
    originalCurrency: string;
    convertedAmount: number;
    targetCurrency: string;
    rate: number;
    isEstimate: boolean;
    timestamp: Date;
}
export interface PriceDisplay {
    amount: number;
    currency: string;
    formatted: string;
    localEquivalent?: ConversionResult;
}
export declare class FxConverter {
    private rates;
    private static instance;
    constructor();
    static getInstance(): FxConverter;
    convert(amount: number, fromCurrency: string, toCurrency: string): ConversionResult;
    convertFromNgn(amountNgn: number, toCurrency: string): ConversionResult;
    convertToNgn(amount: number, fromCurrency: string): ConversionResult;
    formatPrice(amount: number, currency: string, userCurrency?: string): PriceDisplay;
    formatPriceRange(minPrice: number | null, maxPrice: number | null, currency: string, userCurrency?: string): {
        formatted: string;
        localEquivalent?: string;
    };
    getRates(): FxRates;
    needsRefresh(): boolean;
    refreshRates(): Promise<void>;
}
export declare const getFxConverter: () => FxConverter;
export declare const SUPPORTED_CURRENCIES: string[];
export default FxConverter;
