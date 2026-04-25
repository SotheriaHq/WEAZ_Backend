"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SUPPORTED_CURRENCIES = exports.getFxConverter = exports.FxConverter = void 0;
const PLACEHOLDER_RATES = {
    NGN: 1,
    USD: 0.00065,
    GBP: 0.00051,
    EUR: 0.00060,
    GHS: 0.0081,
    KES: 0.0884,
    ZAR: 0.0118,
};
const USD_TO_LOCAL = {
    NGN: 1540,
    GBP: 0.79,
    EUR: 0.93,
    GHS: 12.5,
    KES: 136,
    ZAR: 18.2,
};
class FxConverter {
    constructor() {
        const now = new Date();
        this.rates = {
            base: 'NGN',
            rates: { ...PLACEHOLDER_RATES },
            timestamp: now,
            expiresAt: new Date(now.getTime() + 3600000),
        };
    }
    static getInstance() {
        if (!FxConverter.instance) {
            FxConverter.instance = new FxConverter();
        }
        return FxConverter.instance;
    }
    convert(amount, fromCurrency, toCurrency) {
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
            isEstimate: true,
            timestamp: this.rates.timestamp,
        };
    }
    convertFromNgn(amountNgn, toCurrency) {
        return this.convert(amountNgn, 'NGN', toCurrency);
    }
    convertToNgn(amount, fromCurrency) {
        return this.convert(amount, fromCurrency, 'NGN');
    }
    formatPrice(amount, currency, userCurrency) {
        const curr = currency.toUpperCase();
        let formatted;
        try {
            formatted = new Intl.NumberFormat('en-NG', {
                style: 'currency',
                currency: curr,
                maximumFractionDigits: curr === 'NGN' ? 0 : 2,
            }).format(amount);
        }
        catch {
            formatted = `${curr} ${amount.toLocaleString()}`;
        }
        const result = {
            amount,
            currency: curr,
            formatted,
        };
        if (userCurrency && userCurrency.toUpperCase() !== curr) {
            result.localEquivalent = this.convert(amount, curr, userCurrency);
        }
        return result;
    }
    formatPriceRange(minPrice, maxPrice, currency, userCurrency) {
        const curr = currency.toUpperCase();
        if (!minPrice && !maxPrice) {
            return { formatted: 'Price not set' };
        }
        const formatSingle = (val) => {
            try {
                return new Intl.NumberFormat('en-NG', {
                    style: 'currency',
                    currency: curr,
                    maximumFractionDigits: curr === 'NGN' ? 0 : 2,
                }).format(val);
            }
            catch {
                return `${curr} ${val.toLocaleString()}`;
            }
        };
        let formatted;
        if (minPrice && maxPrice && minPrice !== maxPrice) {
            formatted = `${formatSingle(minPrice)} - ${formatSingle(maxPrice)}`;
        }
        else {
            formatted = formatSingle(minPrice || maxPrice || 0);
        }
        const result = { formatted };
        if (userCurrency && userCurrency.toUpperCase() !== curr) {
            const minConverted = minPrice
                ? this.convert(minPrice, curr, userCurrency).convertedAmount
                : null;
            const maxConverted = maxPrice
                ? this.convert(maxPrice, curr, userCurrency).convertedAmount
                : null;
            const formatLocal = (val) => {
                const uc = userCurrency.toUpperCase();
                try {
                    return new Intl.NumberFormat('en-NG', {
                        style: 'currency',
                        currency: uc,
                        maximumFractionDigits: uc === 'NGN' ? 0 : 2,
                    }).format(val);
                }
                catch {
                    return `${uc} ${val.toLocaleString()}`;
                }
            };
            if (minConverted && maxConverted && minConverted !== maxConverted) {
                result.localEquivalent = `≈ ${formatLocal(minConverted)} - ${formatLocal(maxConverted)}`;
            }
            else {
                result.localEquivalent = `≈ ${formatLocal(minConverted || maxConverted || 0)}`;
            }
        }
        return result;
    }
    getRates() {
        return { ...this.rates };
    }
    needsRefresh() {
        return new Date() > this.rates.expiresAt;
    }
    async refreshRates() {
        console.log('[FxConverter] Rate refresh not yet implemented - using placeholder rates');
        this.rates.timestamp = new Date();
        this.rates.expiresAt = new Date(Date.now() + 3600000);
    }
}
exports.FxConverter = FxConverter;
FxConverter.instance = null;
const getFxConverter = () => FxConverter.getInstance();
exports.getFxConverter = getFxConverter;
exports.SUPPORTED_CURRENCIES = Object.keys(PLACEHOLDER_RATES);
exports.default = FxConverter;
//# sourceMappingURL=fx-converter.js.map