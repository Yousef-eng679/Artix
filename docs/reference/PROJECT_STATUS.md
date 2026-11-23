# Artix Project Status & Implementation Matrix

> **Current Baseline**: Productionized Billing, Strict CAS & True Offline-First Architecture (`v2.5.0`)  
> **Target Release**: Production Ready Local-First Architecture

---

## 1. Subsystem Verification Matrix

| Subsystem / Feature | Implementation State | Verification Method | Status Notes |
|---|---|---|---|
| **IndexedDB Authority (`ArtixDB` v3)** | `IMPLEMENTED` | `db.test.ts`, `userScopedDb.test.ts`, `offlineProjectOutboxSync.test.tsx` | 8-table user-scoped Dexie instances (incl. `projects`) with 100% offline CRUD. |
| **Atomic Multi-Table Mutations** | `IMPLEMENTED` | `atomicMutation.test.ts` | 3-table CRUD, 5-table folder delete, and 6-table project cascade delete transactions. |
| **Outbox Compaction & Causal Barrier** | `IMPLEMENTED` | `outboxMutationAlgebra.test.ts`, `dispatchedSelfEchoAndCausalBarrier.test.ts` | 7-case compaction on undispatched tail entries, sticky `dispatched` flag, and per-entity causal barrier. |
| **Topological DAG Ordering** | `IMPLEMENTED` | `dependencyOrder.test.ts` | Projects -> parent folders -> child folders -> docs/designs -> reverse delete order. |
| **Atomic Server CAS & Idempotency** | `IMPLEMENTED` | `concurrencyCAS.test.ts`, `idempotentMutation.test.ts`, `backendConcurrencyAndRls.pg.test.ts` | Single-transaction `apply_sync_mutation` RPC enforcing `processed_mutations` and strict `p_base_version >= 1`. |
| **Fenced Leases & Atomic Push Ack** | `IMPLEMENTED` | `atomicPushAckAndLeaseTokenFencing.test.ts` | 30s `leaseToken` UUID verified inside atomic `[outbox, sync_metadata]` ack/fail transactions. |
| **Commit-Ordered Pull & Retention Floor** | `IMPLEMENTED` | `pullCursorCommitOrder.test.ts`, `bootstrapHydrationAndRetentionFloor.test.tsx` | Advisory-locked `sync_changes`, `mutation_id` self-echo guard, `bootstrapHydrateAll`, and `resnapshotAll`. |
| **Pending-State & Stale-Buffer Guards** | `IMPLEMENTED` | `pendingStateSafe.test.ts`, `staleBufferProtection.test.tsx` | `PullEngine` never overwrites pending edits; `Editor` and `SystemArchitect` enforce `expectedLocalRevision` (`StaleBufferError`). |
| **LCS 3-Way Diff3 Merge & Conflict UX** | `IMPLEMENTED` | `conflictResolver.test.ts`, `multiDeviceConflictResolution.test.tsx` | LCS `diff3` text merge, `UnresolvedConflictMarkersError` push guard, and `ConflictResolutionCenter` modal. |
| **Web Locks Leader Election** | `IMPLEMENTED` | `tabCoordinator.test.ts`, `pullUiReactivityAndCrossTab.test.tsx` | Native Web Locks single-leader execution + post-commit cross-tab `localRevision` notifications. |
| **Multi-Account Runtime Isolation** | `IMPLEMENTED` | `userSyncRuntimeLifecycle.test.tsx`, `multiAccountEvictionAndStorageScope.test.tsx` | Scoped DB, singleton eviction, `QueryClient` purge, and user-hashed `localStorage` draft/tab keys. |
| **Tombstone Manager** | `IMPLEMENTED` | `tombstonesCorrectness.test.ts` | Soft-delete state machine across all 4 synced entity tables with 30-day 6-table GC. |
| **Multi-Tab Workspace Shell** | `IMPLEMENTED` | `workspaceTabs.test.ts` | URL synchronization, cold deep-link hydration guard, dirty tracking per tab, close confirmation dialogs. |
| **Bundled Monaco Document Forge** | `IMPLEMENTED` | `offlineMonacoBundle.test.ts`, `security.test.ts` | Locally bundled `monaco-editor` 0.57 + worker (zero CDN), split preview, AST-escaped Markdown + safe-URI guard. |
| **System Architect Canvas** | `IMPLEMENTED` | `offlineSystemDesigns.test.tsx`, `systemArchitectPersistence.test.tsx` | React Flow node graph, persisted inline labels/colors, UUID node IDs, drag-aware save deferral, dagre auto-layout. |
| **AI Prompt Compiler** | `IMPLEMENTED` | `ai-architecture.test.ts` | PRD, Vibe, Agentic, and Architecture generators with 2-pass refinement and primary/backup failover. |
| **BYOK Client Key Vault** | `IMPLEMENTED` | `security.test.ts`, `circularImportsDiff3AndCryptoV2.test.ts` | Default `obf:` obfuscation + opt-in AES-GCM 256-bit / PBKDF2 600k (`v: 2`) vault with `v: 1` (250k) backward read compatibility. |
| **Atomic Stripe Billing & Quotas** | `IMPLEMENTED` | `billing.test.ts`, `stripeWebhookAndEntitlementPolicy.test.tsx`, `offlineEntitlementAndQuota.test.tsx` | `reconcile_stripe_subscription` RPC, strict `past_due -> free`, `manual_grants`, serialized `check_plan_tier_limit()`, offline Dexie cache. |
| **PWA & Offline Cold-Start Continuity** | `IMPLEMENTED` | `storageDurabilityAndPwaConfig.test.ts`, `expiredTokenOfflineBoot.test.tsx`, `offlineColdStartAndSyncMatrix.spec.ts` | Workbox `clientsClaim` + `skipWaiting`, self-hosted `@fontsource` fonts, `storage.persist()`, expired-JWT offline session recovery. |
| **GitHub Bi-Directional Sync** | `PLANNED` | — | Direct PR creation and bidirectional git repository syncing. |
| **Excalidraw Integration** | `PLANNED` | — | Hybrid freehand canvas paired with structured node graphs. |

---

## 2. Test Suite Quality Checksums

```text
Layer 1 & 2 (Vitest v3.2.6 Unit, Integration & Fault-Injection): 107 / 107 files passed (698 / 698 tests)
Layer 3 (Real PostgreSQL 17 & PGlite Concurrency, CAS, Billing & RLS): 6 / 6 tests passed (`npm run test:pg`)
Layer 4 (Playwright v1.64.1 Production PWA + Workbox SW E2E): 18 / 18 Chromium specs passed (`npm run test:e2e`)
TypeScript Diagnostic Errors (`npx tsc --noEmit`): 0
ESLint Diagnostic Errors (`npm run lint`): 0
Production Build (`npm run build`): Clean (`dist/` generated with Workbox `sw.js` precaching bundled Monaco & fonts)
```
