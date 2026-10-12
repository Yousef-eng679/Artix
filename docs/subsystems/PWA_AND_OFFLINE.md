# Progressive Web App (PWA) & Offline Asset Caching

> **Status**: `IMPLEMENTED`  
> **Verified Against**: `vite.config.ts`, `dist/sw.js`, `src/test/ux.test.ts`

---

## 1. Overview

Artix is designed to launch and execute under **zero-connectivity conditions** (airplane mode, network outages). While IndexedDB provides offline data authority, the Progressive Web App (PWA) configuration provides **application code and asset authority**.

---

## 2. PWA Build Configuration (`vite.config.ts`)

Configured using `vite-plugin-pwa` with Google Workbox:

```typescript
VitePWA({
  registerType: 'autoUpdate',
  includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'artix-logo.png'],
  manifest: {
    name: 'Artix — Developer Command Center',
    short_name: 'Artix',
    description: 'Local-First Engineering Workspace & Specification Engine',
    theme_color: '#090a0f',
    background_color: '#090a0f',
    display: 'standalone',
    icons: [
      {
        src: 'pwa-192x192.png',
        sizes: '192x192',
        type: 'image/png'
      },
      {
        src: 'pwa-512x512.png',
        sizes: '512x512',
        type: 'image/png'
      }
    ]
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
    runtimeCaching: [
      {
        urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
        handler: 'CacheFirst',
        options: {
          cacheName: 'google-fonts-cache',
          expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 }
        }
      }
    ]
  }
})
```

---

## 3. Workbox Precaching & Service Worker Lifecycle

1. **Build Step (`npm run build`)**: Vite transforms the source code and outputs static chunks into `dist/`. Workbox hashes each output file and generates a precache manifest inside `dist/sw.js`.
2. **Registration (`registerSW.js`)**: When the app loads in a browser, the service worker registers in the background.
3. **Precache Phase**: All JavaScript modules, CSS bundles, SVG icons, and HTML entry points are downloaded into CacheStorage.
4. **Offline Serving**: On subsequent visits, all network requests for application bundles are intercepted and served directly from CacheStorage (Cache-First strategy).
5. **Auto-Update**: When a new version is deployed, the service worker downloads updated chunks in the background and activates upon next tab refresh (`autoUpdate`).

---

## 4. Native Installability

Because Artix fulfills all PWA criteria (HTTPS, valid Web App Manifest, ServiceWorker fetch handler, responsive layout), Chromium and WebKit browsers offer native installation:
- **Desktop**: Installable as a standalone Chrome/Edge desktop app with custom title bar and window framing.
- **Mobile / Tablet**: Add to Home Screen on iOS and Android with standalone display mode.
