# Test fixtures

These files reproduce the **wire format** of each external source so adapters can
be tested without network access.

**Why they exist:** the development sandbox's egress policy blocks every fantasy
data host (see `ARCHITECTURE.md` §2), so adapters cannot be exercised against the
live endpoints from there. They are therefore written against each provider's
documented/observed response shape and verified against these fixtures.

**What they are not:** a substitute for live verification, and not a source of
player data. Player names and values here are synthetic or structural samples
used to exercise parsing. No application code reads this directory.

**Before trusting an adapter in production**, run `pnpm doctor` on a machine with
open egress. It performs the real request against each source and reports whether
the parser still matches reality. An adapter is not considered verified until
that check passes.
