# Reviews QA Checklist

Created: 2026-05-18.

## Backend Automated Coverage

| Scenario | Evidence |
| --- | --- |
| Completed standard order creates review prompt | `src/reviews/review-lifecycle.service.spec.ts` |
| Completed custom order creates review prompt | `src/reviews/review-lifecycle.service.spec.ts` |
| Uncompleted order does not create prompt | `src/reviews/review-lifecycle.service.spec.ts` |
| Cancelled/refunded order does not create prompt | `src/reviews/review-lifecycle.service.spec.ts` |
| Submit product review | `src/reviews/review-lifecycle.service.spec.ts` |
| Submit custom/design review | `src/reviews/review-lifecycle.service.spec.ts` |
| Duplicate review blocked | `src/reviews/review-lifecycle.service.spec.ts` |
| Own-brand review blocked | `src/reviews/review-lifecycle.service.spec.ts` |
| Edit within 24 hours succeeds | `src/reviews/review-lifecycle.service.spec.ts` |
| Edit after 24 hours fails | `src/reviews/review-lifecycle.service.spec.ts` |
| Edit window does not reset after edit | `src/reviews/review-lifecycle.service.spec.ts` |
| Delete own review succeeds after 24 hours | `src/reviews/review-lifecycle.service.spec.ts` |
| Brand cannot delete buyer review | `src/reviews/review-lifecycle.service.spec.ts` |
| Deleted review excluded from public list | `src/reviews/review-lifecycle.service.spec.ts` |
| Deleted review excluded from aggregate | `src/reviews/review-lifecycle.service.spec.ts` |
| Rating validation 1-5 | `src/reviews/review-lifecycle.service.spec.ts` |
| Satisfaction validation | `src/reviews/review-lifecycle.service.spec.ts` |
| Skip prompt | `src/reviews/review-lifecycle.service.spec.ts` |
| Public display respects feature flags | `src/reviews/review-lifecycle.service.spec.ts` |

## Manual / Integration Follow-Up

Frontend and native UI are intentionally out of scope for Phase 16A. Later phases should verify:

- Buyer prompt surfacing after completed standard order.
- Buyer prompt surfacing after completed custom order.
- Edit countdown display.
- Delete confirmation copy.
- Public product/brand summary rendering behind flags.
- Collection/design public display remains hidden until flags are enabled.
