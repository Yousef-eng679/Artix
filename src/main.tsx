import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { AuthProvider } from "@/hooks/useAuth";
import { UserSyncRuntimeProvider } from "@/contexts/UserSyncRuntimeContext";
import { ThemeProvider } from "@/hooks/useTheme";
import App from "./App.tsx";
import "./index.css";

// PWA service worker guard: prevent SW registration in iframes / preview
const isInIframe = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

const isPreviewHost = window.location.hostname.includes("id-preview--");

if (isPreviewHost || isInIframe) {
  navigator.serviceWorker?.getRegistrations().then((registrations) => {
    registrations.forEach((r) => r.unregister());
  });
}

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <UserSyncRuntimeProvider>
            <ThemeProvider>
              <App />
            </ThemeProvider>
          </UserSyncRuntimeProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
