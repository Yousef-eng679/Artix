# Network Boundary & Remote Endpoint Inventory

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/test/architecture/networkBoundary.test.ts` (`v2.5.0`)

---

## 1. Network Architecture Overview

Artix enforces strict centralization of network calls across all four synced workspace entities (`projects`, `documents`, `system_designs`, `workspace_folders`). **Zero UI components or workspace resource hooks perform direct cloud mutations on synced tables, and zero external CDN requests are issued for fonts or Monaco Editor.**

All outbound network communication is partitioned into four authorized gateways:
1. **Replication Gateway (`src/lib/sync/`)**: `executeAtomicMutation` (`apply_sync_mutation` RPC) for pushes across `ProjectPushAdapter`, `DocumentPushAdapter`, `SystemDesignPushAdapter`, and `WorkspaceFolderPushAdapter`, plus `PullEngine` (`get_sync_feed_bounds`, `sync_changes`, and cold/resnapshot hydration).
2. **Account, Entitlement & AI-History Gateway (`src/hooks/`, `src/lib/emailValidation.ts`)**: Supabase Auth PKCE, `validate-email`, `subscriptions` / `manual_grants` reads (cached to `database_meta['cached_subscription']` for offline use), `profiles`, and `prd_generations` / `vibe_generations` / `agentic_workflows`.
3. **Billing Gateway (`supabase/functions/`)**: Stripe checkout, billing portal, and webhook endpoints.
4. **AI Inference Gateway (`src/lib/ai/registry.ts` & `src/lib/ai/providers/`)**: BYOK direct client calls to configured AI providers with primary-to-backup failover.

---

## 2. Complete Authorized Network Endpoints Catalog

| Subsystem | Initiator Module | Protocol | Remote Endpoint | Payload / Operations |
|---|---|---|---|---|
| **Sync Push (Primary)** | `src/lib/sync/adapters/idempotency.ts` (`executeAtomicMutation`) | HTTPS POST (RPC) | `POST /rest/v1/rpc/apply_sync_mutation` | Single-transaction idempotency check (`processed_mutations`) + strict CAS mutation (`project`, `document`, `system_design`, `workspace_folder`) + `sync_changes` event. |
| **Sync Feed Bounds** | `PullEngine.getFeedBounds` | HTTPS POST (RPC) | `POST /rest/v1/rpc/get_sync_feed_bounds` | Returns `{ min_retained_sequence, max_sequence }` from `sync_retention_state` and `sync_changes`. |
| **Sync Pull (Delta)** | `PullEngine.pullBatch` | HTTPS GET | `GET /rest/v1/sync_changes` | Range queries: `sequence > lastCursor ORDER BY sequence ASC LIMIT 50`. |
| **Sync Pull (Hydration / Resnapshot)** | `PullEngine.bootstrapHydrateAll` / `resnapshotAll` | HTTPS GET | `GET /rest/v1/{projects,workspace_folders,documents,system_designs}` | Cold-start snapshot hydration or retention-floor resnapshot recovery. |
| **Realtime** | `RealtimeSyncManager` | WSS (WebSocket) | `wss://<ref>.supabase.co/realtime/v1/websocket` | Channel subscription on user-scoped change events (50ms debounced wakeup on leader tab only). |
| **Auth** | `useAuth.tsx` | HTTPS POST | `/auth/v1/token` | PKCE token exchange, online refresh, and session management. |
| **Email Validation** | `src/lib/emailValidation.ts` | HTTPS POST | `/functions/v1/validate-email` | Pre-signup disposable-domain check and DNS-over-HTTPS MX lookup (`cloudflare-dns.com`, `dns.google`). |
| **Billing Checkout** | `UpgradePrompt.tsx`, `Pricing.tsx` | HTTPS POST | `/functions/v1/create-checkout-session` | Server price-allowlisted Stripe checkout session redirect URL. |
| **Billing Portal** | `Settings.tsx` | HTTPS POST | `/functions/v1/create-portal-session` | Stripe customer billing portal session URL. |
| **Stripe Webhook** | Stripe Servers -> `stripe-webhook` | HTTPS POST | `/functions/v1/stripe-webhook` | HMAC signature verification + live `stripe.subscriptions.retrieve` + atomic `reconcile_stripe_subscription` RPC. |
| **Entitlements & Quotas** | `useSubscription.tsx`, `useUsageLimits.tsx` | HTTPS GET / HEAD | `/rest/v1/{subscriptions,manual_grants,prd_generations,vibe_generations,agentic_workflows}` | Online entitlement & monthly AI count queries (cached in `database_meta` for offline reads). |
| **AI BYOK** | `src/lib/ai/registry.ts` + `providers/*.ts` | HTTPS POST (SSE) | `api.openai.com`, `api.anthropic.com`, `generativelanguage.googleapis.com`, `api.groq.com`, `openrouter.ai`, `http://localhost:11434` | Direct user-credentialed streaming inference with primary -> backup failover. |

---

## 3. Prohibited & Eliminated Network Paths

Enforced continuously by `src/test/architecture/networkBoundary.test.ts`:
- `src/hooks/useDocuments.tsx`, `useSystemDesigns.tsx`, `useWorkspaceFolders.tsx` -> direct `@/integrations/supabase/client` imports (prohibited).
- Direct `.insert`, `.update`, `.delete`, or `.upsert` on `projects`, `documents`, `system_designs`, or `workspace_folders` anywhere outside `src/lib/sync/adapters/` (prohibited).
- `.rpc('apply_sync_mutation')` anywhere outside `src/lib/sync/adapters/idempotency.ts` (prohibited).
- Legacy `/api/save` endpoints and `navigator.sendBeacon(` unload calls anywhere in `src/` (permanently removed; `src/lib/cache/tabCloseGuard.ts` flushes strictly to local user-scoped `localStorage`).
- External CDN fetches for Google Fonts or jsDelivr Monaco Editor assets (permanently removed; fonts and Monaco workers are bundled locally and precached by Workbox).
