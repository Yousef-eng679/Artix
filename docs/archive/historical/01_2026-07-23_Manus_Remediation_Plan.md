## Artix Remediation Plan for Deployment Blockers

**Date:** July 23, 2026
**Author:** Manus AI
**Role:** Senior Software Engineer & Cybersecurity Expert

## 1. Introduction

This report outlines the remaining critical issues preventing the Fenix (Artix) application from achieving production deployment readiness. While significant progress has been made in addressing initial security vulnerabilities, three key areas require immediate attention: a functional regression in the billing portal, the non-mandatory nature of AI API key encryption, and incomplete CORS hardening on Supabase Edge Functions. For each issue, a detailed explanation, impact analysis, and a precise execution plan are provided.

## 2. Remaining Critical Issues and Remediation Plan

### 2.1. Functional Regression: Billing Portal Failure

**Issue Description:**
The `create-portal-session` Supabase Edge Function expects a `return_url` parameter in its request body to redirect users back to the application after managing their billing. However, the `Settings.tsx` frontend component, specifically within the `handleManageBilling` function, invokes this Edge Function with an empty request body (`body: {}`).

**Why it's a Blocker:**
This mismatch leads to a `400 Bad Request` error from the Edge Function, rendering the 
billing portal inaccessible to users. This is a critical functional regression that directly impacts user experience and revenue generation for paid tiers.

**Execution Plan:**
1.  **Locate `Settings.tsx`:** Identify the `handleManageBilling` function within `src/pages/Settings.tsx`.
2.  **Modify `supabase.functions.invoke` call:** Change the `body` parameter for the `create-portal-session` invocation to include the `return_url`.
    *   **Current:** `body: {}`
    *   **Proposed:** `body: { return_url: window.location.origin + '/settings' }`
3.  **Test:** Verify that clicking "Manage Subscription" successfully redirects to the Stripe billing portal and returns to the settings page upon completion.

### 2.2. Security: Non-Mandatory AI Key Encryption (SEC-06)

**Issue Description:**
The application provides a WebCrypto-based encryption mechanism for user-provided AI API keys stored in `localStorage`. However, this encryption is optional, and users can choose to disable it, leading to plaintext storage of sensitive API keys. The UI (`AISettingsCard.tsx`) explicitly offers a "Disable encryption" option.

**Why it's a Blocker:**
Storing API keys in plaintext, even in `localStorage`, makes them vulnerable to various client-side attacks, including Cross-Site Scripting (XSS) and malicious browser extensions. An attacker exploiting an XSS vulnerability could easily exfiltrate these keys, leading to unauthorized access to AI services and potential billing abuse. Mandatory encryption is a fundamental security requirement for handling sensitive user credentials.

**Execution Plan:**
1.  **Locate `AISettingsCard.tsx`:** Identify the `EncryptionPanel` component within `src/components/AI/AISettingsCard.tsx`.
2.  **Remove 
 **Disable encryption** option:** Remove the UI elements and logic that allow users to disable encryption. The encryption should be mandatory once an API key is entered.
3.  **Modify `saveSettings` logic:** Ensure that `saveSettings` in `src/lib/ai/storage.ts` always encrypts API keys if a passphrase has been set, and prompts for a passphrase if one is not present when an API key is being saved.
4.  **Enforce passphrase creation:** Upon the first entry of an AI API key, if encryption is not already enabled, the user should be prompted to set a strong passphrase, making encryption the default and mandatory storage method.
5.  **Test:** Verify that API keys are always stored encrypted and cannot be saved in plaintext. Test the passphrase change and unlock/lock functionality.

### 2.3. Security: Incomplete CORS Hardening (SEC-05)

**Issue Description:**
The Supabase Edge Functions, specifically `create-checkout-session` and `create-portal-session`, are still configured to respond with `Access-Control-Allow-Origin: '*'` in their CORS headers. While a `getCorsHeaders` helper function exists in `supabase/functions/_shared/cors.ts` that can validate origins against a whitelist, the Edge Functions are not utilizing this helper effectively to restrict access.

**Why it’s a Blocker:**
Using a wildcard `*` for `Access-Control-Allow-Origin` allows any website to make cross-origin requests to these sensitive API endpoints. This significantly increases the attack surface, potentially enabling malicious sites to trigger billing operations or gather sensitive user data if combined with other vulnerabilities (e.g., CSRF). It undermines the principle of least privilege and is a critical misconfiguration for production environments.

**Execution Plan:**
1.  **Locate Edge Functions:** Identify `index.ts` files in `supabase/functions/create-checkout-session` and `supabase/functions/create-portal-session`.
2.  **Modify CORS handling:** In both Edge Functions, replace the direct use of `corsHeaders` with a call to `getCorsHeaders`.
    *   **Current (example from `create-checkout-session/index.ts`):**
        ```typescript
        if (req.method === 'OPTIONS') {
          return new Response('ok', { headers: corsHeaders })
        }
        // ...
        return new Response(JSON.stringify({ url: session.url }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          status: 200,
        })
        ```
    *   **Proposed:**
        ```typescript
        import { getCorsHeaders } from '../_shared/cors.ts';
        const allowedOrigins = [Deno.env.get('PRODUCTION_FRONTEND_URL') || 'http://localhost:8080']; // Replace with actual production URL

        if (req.method === 'OPTIONS') {
          return new Response('ok', { headers: getCorsHeaders(req, allowedOrigins) })
        }
        // ...
        return new Response(JSON.stringify({ url: session.url }), {
          headers: { ...getCorsHeaders(req, allowedOrigins), 'Content-Type': 'application/json' },
          status: 200,
        })
        ```
3.  **Environment Variable:** Ensure a `PRODUCTION_FRONTEND_URL` environment variable is configured for the Supabase project to specify the allowed origin(s) in production.
4.  **Test:** Verify that requests from unauthorized origins are rejected by the Edge Functions, while requests from the allowed origin are processed correctly.

## 3. Unit Testing Suite for Remediation Verification

To ensure the successful implementation of the fixes and prevent regressions, the following unit tests should be created or updated and must pass:

### 3.1. Billing Portal Fix (Functional Regression)
-   **Test Case:** `should successfully redirect to Stripe billing portal with correct return_url`
    *   **Description:** Simulate a user clicking "Manage Subscription" and assert that the `create-portal-session` Edge Function is invoked with the expected `return_url` and that the subsequent `window.location.href` is set correctly.
    *   **Mocking:** Mock `supabase.functions.invoke` to return a successful response with a `data.url`.

### 3.2. AI Key Encryption Enforcement (SEC-06)
-   **Test Case:** `should always store API keys encrypted when a passphrase is set`
    *   **Description:** Simulate saving an API key after a passphrase has been set and verify that `localStorage` contains an encrypted blob (`ENC_KEY`) and not a plaintext key (`KEY`).
    *   **Mocking:** Mock `localStorage` and `crypto.subtle` functions.
-   **Test Case:** `should prompt for passphrase if encryption is not enabled when saving an API key`
    *   **Description:** Simulate saving an API key when encryption is disabled and assert that the UI (or underlying logic) triggers a mandatory passphrase setup flow.
    *   **Mocking:** Mock UI interactions or internal state flags.
-   **Test Case:** `should prevent disabling encryption without valid passphrase`
    *   **Description:** Simulate attempting to disable encryption with an incorrect passphrase and assert that the operation fails.

### 3.3. CORS Hardening (SEC-05)
-   **Test Case:** `create-checkout-session should reject requests from unauthorized origins`
    *   **Description:** Invoke the `create-checkout-session` Edge Function with an `Origin` header that is not in the `allowedOrigins` list and assert that the response includes appropriate CORS error headers or a 403 status.
    *   **Mocking:** Mock `Deno.env.get` for `PRODUCTION_FRONTEND_URL`.
-   **Test Case:** `create-checkout-session should allow requests from authorized origins`
    *   **Description:** Invoke the `create-checkout-session` Edge Function with an `Origin` header that is in the `allowedOrigins` list and assert that the request is processed successfully (e.g., returns a 200 status).
-   **Test Case:** `create-portal-session should reject requests from unauthorized origins`
    *   **Description:** Similar to the `create-checkout-session` test, but for the `create-portal-session` Edge Function.
-   **Test Case:** `create-portal-session should allow requests from authorized origins`
    *   **Description:** Similar to the `create-checkout-session` test, but for the `create-portal-session` Edge Function.

## 4. Conclusion

Addressing these remaining issues is paramount for the Fenix project to achieve a production-ready state. The proposed execution plan provides clear, actionable steps, and the outlined unit tests will serve as a robust verification mechanism. Once these remediations are successfully implemented and verified, the project will be significantly more secure and functionally stable, paving the way for a confident deployment. 
