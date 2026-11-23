# Progressive Web App (PWA) & Offline Asset Caching

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `vite.config.ts`, `src/components/Editor/monacoSetup.ts`, `src/lib/auth/offlineSession.ts`, `src/test/pwa/storageDurabilityAndPwaConfig.test.ts`, `src/test/editor/offlineMonacoBundle.test.ts`, `tests/e2e/offlineColdStartAndSyncMatrix.spec.ts`

---

## 1. Overview

Artix is designed to launch and execute under **zero-connectivity conditions** (airplane mode, cold reloads with an expired JWT, network outages). While IndexedDB (`ArtixDB` v3) provides offline data authority, the Progressive Web App (PWA) configuration provides **100% self-hosted application code, font, and Monaco Editor worker authority** with zero external CDN dependencies.

---

## 2. PWA Build Configuration (`vite.config.ts`)

Configured using `vite-plugin-pwa` with Google Workbox:

```typescript
VitePWA({
  registerType: 'autoUpdate',
  includeAssets: ['favicon.ico', 'pwa-192x192.png', 'pwa-512x512.png'],
  manifest: {
    name: 'Artix — Developer Command Center',
    short_name: 'Artix',
    description: 'Markdown/XML specs, system diagrams & AI prompts — all in one workspace.',
    theme_color: '#1a1a2e',
    background_color: '#1a1a2e',
    display: 'standalone',
    start_url: '/',
    icons: [
      { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
      { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
      { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  },
  workbox: {
    clientsClaim: true,
    skipWaiting: true,
    cleanupOutdatedCaches: true,
    navigateFallback: '/index.html',
    navigateFallbackDenylist: [/^\/~oauth/],
    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,ttf}'],
    maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MiB to precache local Monaco bundle
  },
  devOptions: {
    enabled: false,
  },
})
```

### Zero External CDN Dependencies & Security Hardening
- **Locally Bundled Monaco Editor (`src/components/Editor/monacoSetup.ts`)**: Configures `@monaco-editor/react` via `loader.config({ monaco })` against locally bundled `monaco-editor` (`0.57.0`) and a Vite `?worker` bundle (`editor.worker`), eliminating runtime fetches to `cdn.jsdelivr.net`.
- **Self-Hosted Typography (`src/main.tsx`)**: Bundles `@fontsource/inter` and `@fontsource/jetbrains-mono` `.woff2` assets directly into the Workbox precache manifest, eliminating external requests to `fonts.googleapis.com` and `fonts.gstatic.com`.
- **Zero Authenticated API Runtime Caching (Audit F-004)**: Workbox defines **no** `runtimeCaching` rules for Supabase REST endpoints, and `clearSensitiveBrowserCaches()` purges any legacy `supabase-api-cache` on app boot and sign-out so authenticated responses are never shared in CacheStorage.

---

## 3. Workbox Precaching, Durable Storage & Cold-Start Lifecycle

1. **Immediate Claim on Visit 1 (`clientsClaim` + `skipWaiting`)**: The generated `dist/sw.js` activates and claims control of the page on the initial online visit without requiring a second reload before going offline.
2. **SPA Offline Deep-Link Navigation (`navigateFallback: '/index.html'`)**: Offline reloads on any deep link (e.g. `/dashboard` or `/projects/:id?doc=:docId`) are served from the precached app shell.
3. **Offline Expired-JWT Continuity (`src/lib/auth/offlineSession.ts`)**: If an offline cold start occurs after the cached JWT's `exp` timestamp has elapsed, `recoverOfflineSessionFromStorage()` restores the local user session so `ArtixDB_v2_<hash>` mounts offline while cloud sync stays paused until online token refresh.
4. **Offline-First TanStack Query (`src/main.tsx`)**: Global `QueryClient` defaults use `networkMode: 'offlineFirst'` (and local Dexie/entitlement hooks specify `networkMode: 'always'`), ensuring queries and mutations never pause when `navigator.onLine === false`.
5. **Durable Storage Request**: `UserSyncRuntime.start()` invokes `navigator.storage.persist()` and monitors quota usage via `navigator.storage.estimate()`.

---

## 4. Native Installability

Because Artix fulfills all PWA criteria (HTTPS, valid Web App Manifest, ServiceWorker fetch handler, responsive layout), Chromium and WebKit browsers offer native installation:
- **Desktop**: Installable as a standalone Chrome/Edge desktop app with custom title bar and window framing (`PWAInstallPrompt.tsx`).
- **Mobile / Tablet**: Add to Home Screen on iOS and Android with standalone display mode.
