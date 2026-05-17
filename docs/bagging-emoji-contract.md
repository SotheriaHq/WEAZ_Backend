# Bagging Emoji Contract

## Constants

- Web item-level Bag It: `fthreadly/src/constants/bagging.ts` exports `BAG_IT_EMOJI`.
- Web destination-level My Bag: `fthreadly/src/constants/bagging.ts` exports `MY_BAG_EMOJI`.
- Mobile item-level Bag It: `threadly-mobile/src/constants/bagging.ts` exports `BAG_IT_EMOJI`.
- Mobile destination-level My Bag: `threadly-mobile/src/constants/bagging.ts` exports `MY_BAG_EMOJI`.

## Values

- `BAG_IT_EMOJI`: shopping bags, `String.fromCodePoint(0x1f6cd, 0xfe0f)`.
- `MY_BAG_EMOJI`: basket, `String.fromCodePoint(0x1f9fa)`.

## Usage Rules

- Item-level standard and custom bagging actions use `BAG_IT_EMOJI`.
- Destination-level My Bag navigation, drawer, sheet, and empty state badges use `MY_BAG_EMOJI`.
- Standard and custom item-level bagging should be distinguished by text, state, or color, not by changing the Bag It emoji.
- Cart language and cart emoji should not appear in buyer-facing bagging flows touched by Phase 14.
- Internal file names, Redux slice names, and existing cart model names can remain unchanged in this phase.
