"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InputSanitizationPipe = void 0;
const common_1 = require("@nestjs/common");
const input_sanitizer_1 = require("../utils/input-sanitizer");
let InputSanitizationPipe = class InputSanitizationPipe {
    transform(value, metadata) {
        if (!value)
            return value;
        if (metadata.type !== 'body' &&
            metadata.type !== 'query' &&
            metadata.type !== 'param') {
            return value;
        }
        return (0, input_sanitizer_1.sanitizeRequestInput)(value);
    }
};
exports.InputSanitizationPipe = InputSanitizationPipe;
exports.InputSanitizationPipe = InputSanitizationPipe = __decorate([
    (0, common_1.Injectable)()
], InputSanitizationPipe);
//# sourceMappingURL=input-sanitization.pipe.js.map