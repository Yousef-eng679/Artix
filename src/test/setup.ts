import "@testing-library/jest-dom";
import "fake-indexeddb/auto";
import { vi } from "vitest";
import { FunctionsClient } from "@supabase/functions-js";

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  }),
});

// Provide fallback mock env vars for testing environments without .env
if (!process.env.VITE_SUPABASE_URL) {
  process.env.VITE_SUPABASE_URL = "https://dummy.supabase.co";
}
if (!process.env.VITE_SUPABASE_PUBLISHABLE_KEY) {
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = "dummy-anon-key";
}

// Intercept Edge Function calls during unit tests to prevent external DNS queries
vi.spyOn(FunctionsClient.prototype, "invoke").mockImplementation(async (functionName) => {
  if (functionName === "validate-email") {
    return { data: { valid: true }, error: null };
  }
  return { data: null, error: null };
});

