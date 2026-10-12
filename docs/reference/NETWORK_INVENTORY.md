# Network Boundary & Remote Endpoint Inventory

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `src/test/architecture/networkBoundary.test.ts` (Phase C4)

---

## 1. Network Architecture Overview

Post-C12 Artix enforces complete centralization of network calls. **Zero UI hooks or React components are permitted to invoke network APIs directly.**

All network communication is strictly partitioned into three authorized gateways:
1. **Replication Gateway (`src/lib/sync/`)**: Push adapters and PullEngine for workspace synchronization.
2. **Billing Gateway (`supabase/functions/`)**: Stripe checkout, portal, and webhook endpoints.
3. **AI Inference Gateway (`src/lib/ai/`)**: BYOK direct client calls to frontier AI providers.

---

## 2. Complete Authorized Network Endpoints Catalog

| Subsystem | Initiator Class / Hook | Protocol | Remote Endpoint | Payload / Operations |
|---|---|---|---|---|
| **Sync Push** | `DocumentPushAdapter` | HTTPS POST/PATCH/DELETE | `POST /rest/v1/documents` | Monotonic CAS updates with `version` predicate; soft/hard delete. |
| **Sync Push** | `SystemDesignPushAdapter` | HTTPS POST/PATCH/DELETE | `POST /rest/v1/system_designs` | Board state serialization; CAS version predicate. |
| **Sync Push** | `FolderPushAdapter` | HTTPS POST/PATCH/DELETE | `POST /rest/v1/workspace_folders` | Hierarchy updates; cascading deletion payloads. |
| **Idempotency**| `idempotency.ts` | HTTPS SELECT / UPSERT | `/rest/v1/processed_mutations` | Check and record UUID v4 `mutationId` ledger. |
| **Sync Pull** | `PullEngine` | HTTPS GET | `GET /rest/v1/sync_changes` | Range queries: `sequence > lastCursor ORDER BY sequence ASC LIMIT 100`. |
| **Realtime** | `RealtimeSyncManager` | WSS (WebSocket) | `wss://<ref>.supabase.co/realtime/v1/websocket` | Channel subscription on user-scoped change events (Wakeup only). |
| **Auth** | `useAuth.tsx` | HTTPS POST | `/auth/v1/token?grant_type=pkce` | PKCE token exchange, refresh, and session management. |
| **Billing** | `UpgradePrompt.tsx` | HTTPS POST | `/functions/v1/create-checkout-session` | Request Stripe checkout redirect URL with JWT verification. |
| **Billing** | `BillingPortal.tsx` | HTTPS POST | `/functions/v1/create-portal-session` | Request Stripe customer billing portal URL. |
| **Stripe** | Stripe Webhook | HTTPS POST | `/functions/v1/stripe-webhook` | External Stripe event listener with HMAC signature verification. |
| **AI BYOK** | `src/lib/ai/service.ts` | HTTPS POST (SSE) | `https://api.openai.com/v1/chat/completions`, `api.anthropic.com`, etc. | Direct user-credentialed streaming inference. |

---

## 3. Prohibited & Eliminated Network Paths (Phase C4)

The following historical call paths have been **permanently eliminated**:
-  `src/hooks/useDocuments.tsx` -> `supabase.from('documents').select(...)` (Eliminated in C4)
-  `src/hooks/useDocuments.tsx` -> `supabase.from('documents').insert/update/delete(...)` (Eliminated in C4)
-  `src/hooks/useSystemDesigns.tsx` -> `supabase.from('system_designs').select/insert/update/delete(...)` (Eliminated in C4)
-  `src/hooks/useWorkspaceFolders.tsx` -> `supabase.from('workspace_folders').*` (Eliminated in C4)
-  `src/pages/ProjectWorkspace.tsx` -> direct cloud fetches (Eliminated in C4)

All workspace state is served locally from IndexedDB via `DocumentRepository`, `SystemDesignRepository`, and `WorkspaceFolderRepository`.
