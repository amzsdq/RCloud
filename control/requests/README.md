# RCloud request queue

Production request files are immutable and named `<request_id>.json`. Producers create; they do not update. `control/queue-index.json` is the ordered manifest and must be updated with optimistic GitHub SHA semantics so concurrent producer conflicts are retried rather than silently overwriting another request.

Do not place secrets or credentials here.
