# Product publication alerts

A product has one publication alert for its lifetime. Unpublishing, editing,
republishing or rescheduling does not reset `publishNotifiedAt`. The marker means
that the alert was handed to the notification queue, processed by the inline
fallback, or handled with no eligible recipients. It is not a device-delivery
receipt. These rules were confirmed on 24 October 2026.

Both immediate publication and the five-minute recovery sweep use current
Product/Brand/User eligibility: active, published, not archived/deleted, due now
or without a schedule, and an unset marker. The sweep also recovers immediate
publications whose handoff failed. Accepted user-to-brand patchers are eligible;
the owner, pending connections and brand-to-brand connections are excluded.
Notification preferences, email suppression and channel policies still apply.

The sweep joins metadata for at most 200 products and keyset-pages connections
at 500 rows across their distinct owners. Products of the same brand reuse the
audience page. Each product/recipient receives a deterministic UUID derived from
the product's first-publication namespace. Queue and fallback use the same UUID.
Durable consumer failures are retried, and existing notification identities are
loaded in batches of 25. A failed product handoff or incomplete audience scan
remains pending. Successful products, including empty audiences, are marked in
one conditional update.

Roll out the updated notification consumer before enabling the API/scheduler
producer: older consumers do not understand `notificationNamespace`. Keep the
consumer and producer on the same release during regression. No public HTTP
response or client contract changes; desktop, tablet, browser-mobile and native
consume the resulting shared notification records.

Local tests cover republishing, empty audiences, queue-only operation, fallback,
partial failures, ownership changes, audience paging, failed scans and stable
identity replay. The disposable PostgreSQL fixture checks actual eligibility,
two metadata/audience SELECTs for 26 products, empty-audience handling and replay
without duplicate notification rows. Provider/Redis calls are captured locally;
this does not establish live push delivery or a production capacity number.

Race and delivery review must still cover audience edits during a long sweep,
publication edits after its eligibility snapshot, crashes around channel side
effects, exhausted queue jobs and sweep duration at large audience sizes. Bounded
memory and fewer reads do not establish a latency or throughput guarantee.
