# Custom-order conversation consistency

Standard payment callbacks, custom-order placement and the main messaging flow use the same buyer/brand advisory-lock namespace. Placement locks the selected conversation before reading its current message state. The order link, participants, placement message, preview and recipient notification outbox records commit in one database transaction.

A repeated placement returns the existing message and repairs notification dispatch. It does not emit another message event or overwrite a newer conversation preview. New placement timestamps advance beyond the current last message, including after a database lock wait. Queue failure after commit leaves durable notification records for replay or the scheduled dispatcher.

`node scripts/verify-checkout-media-batching.cjs` exercises the real service in a UUID-named disposable loopback PostgreSQL database. Setting `VERIFY_LOCAL_REDIS_OUTBOX=true` also checks actual Redis/BullMQ recovery. The expanded fixture has seven custom-conversation cases: 26 identical callbacks, 26 distinct orders on one pair, mixed standard/custom cold callbacks, an older replay after a newer shopper message, a real row-lock wait, an actual outbox constraint failure with rollback, and post-commit dispatch failure/recovery. The combined 39-case run passed with Redis and database cleanup.

These backend guarantees apply to all clients using order placement. They do not demonstrate device delivery or authorize a production capacity claim. Existing old unpaired-thread adoption remains until the separate compatibility retirement. Drain older API workers during rollout because they do not share all these transaction boundaries.
