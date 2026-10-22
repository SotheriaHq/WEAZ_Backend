/**
 * Type a `forwardRef` constructor parameter without emitting a runtime
 * reference to the class.
 *
 * SWC emits `design:paramtypes` metadata as `typeof X === "undefined" ? Object : X`.
 * When two service FILES import each other, one class binding is still in its
 * temporal dead zone while the other file evaluates, and even `typeof` on a TDZ
 * binding throws ("Cannot access 'PaymentService' before initialization").
 * `forwardRef(() => X)` defers the INJECTION token, but not that metadata.
 *
 * A type alias has no runtime value, so the emitted metadata falls back to
 * `Object` and the class is only read lazily inside `forwardRef`. This is the
 * pattern from the NestJS SWC recipe ("WrapperType").
 */
export type ForwardRefType<T> = T;
