# ADR-007: Realtime as Latency Accelerator, Not Correctness Source

- **Status**: `ACCEPTED` / `IMPLEMENTED`
- **Date**: 2026-09-28
- **Deciders**: Architecture Team
- **Related Files**: `src/lib/sync/realtimeSync.ts`, `src/lib/sync/pullEngine.ts`, `src/test/sync/realtimeSync.test.ts`

---

## Context

Supabase Realtime provides WebSocket channels for receiving database events. A naive architectural design would use WebSocket messages as the direct data delivery mechanism: when a WebSocket payload arrives, update IndexedDB directly.

However, WebSocket transports are inherently unreliable over public mobile networks:
1. WebSockets disconnect during sleep, lock-screen, or network switches.
2. Dropped packets during disconnections result in permanently lost updates if Realtime is the sole data vehicle.
3. Rapid typing bursts create message storms that overwhelm client CPU.

---

## Decision

We decided to establish that **Realtime is strictly a Latency Optimizer and Wakeup Signal**:
- Realtime events NEVER write directly into IndexedDB entity tables.
- Instead, incoming Realtime events simply wake up the `PullEngine` by calling `syncEngine.triggerSync(userId, { reason: 'realtime' })`.
- The `PullEngine` queries the durable PostgreSQL change feed (`public.sync_changes`) using its persistent sequence cursor.
- If Realtime is disconnected, blocked, or fails entirely, the system continues to synchronize correctly via background cursor polling.

---

## Alternatives Considered

1. **Direct Application of WebSocket Payloads**:
   - *Why rejected*: If a WebSocket drops 2 packets during a reconnect, the client is permanently out of sync until a hard page reload.
2. **Client-Maintained Sequence Buffering over WebSockets**:
   - *Why rejected*: Duplicates the functionality already cleanly provided by the PostgreSQL `sync_changes` table.

---

## Consequences

### Positive
- Complete network resilience: synchronization correctness is completely independent of WebSocket connection stability.
- Rapid burst events are easily debounced (150ms leading-edge trigger) without risking data loss.
- Zero data loss during network reconnects (Scenario I verified).

### Negative / Tradeoffs
- A Realtime notification requires a follow-up HTTPS REST fetch to `sync_changes`, adding ~50ms of network latency compared to raw payload application.

---

## Current Implementation

- `src/lib/sync/realtimeSync.ts`
- Verified in `src/test/sync/realtimeLifecycleRecovery.test.ts` and `src/test/sync/correctnessMatrix.test.ts` (Scenario I).
