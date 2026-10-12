# Artix — Test Suite Correctness Audit & Improvement Plan Brief

## Purpose

This document is an **audit brief for the coding agent**, not permission to immediately rewrite the test suite.

The agent must compare these findings against the **actual current local working tree**, confirm or reject each finding, identify additional issues, and then produce a concrete implementation plan for modifying or creating tests.

The core question is:

> Can important Artix behavior be broken while the tests still pass?

A green suite is useful only when the tests meaningfully exercise the behavior they claim to verify.

---

# 1. Current Baseline

Current branch:

```text
feat/project-workspace-ux
```

Current remote branch HEAD observed during this audit:

```text
c1283c711d9149d2cf62597c1de9f7dab1597dcb
```

The latest local test run reported:

```text
Test Files: 26 passed
Tests:      201 passed
Failures:   0
```

Do **not** use `201 passed` as a measure of test quality.

The local working tree is the source of truth. Do not reset or replace local work merely because the remote branch is older.

---

# 2. Mandatory Audit Procedure

The agent must execute this sequence before changing tests:

```text
READ THIS REPORT
      ↓
READ LOCAL WORKING TREE
      ↓
READ TEST CONFIGURATION
      ↓
READ CURRENT TEST FILES
      ↓
READ THE PRODUCTION CODE THOSE TESTS CLAIM TO VERIFY
      ↓
COMPARE CLAIMED BEHAVIOR WITH ACTUAL COVERAGE
      ↓
CONFIRM / REJECT FINDINGS
      ↓
IDENTIFY NEW FINDINGS
      ↓
CREATE A TEST-IMPROVEMENT PLAN
      ↓
ONLY THEN IMPLEMENT
```

Start with:

```bash
git status
git branch --show-current
git log --oneline --decorate -10
git diff
git diff --name-status
```

Do not silently discard or overwrite existing local work.

---

# 3. Expected Test Architecture

Artix should use several testing layers, each with a clear responsibility:

```text
                         TEST PYRAMID

                            E2E
                   Real browser / real UI
                           ▲
                           │
                      Integration
          Real composition with controlled boundaries
                           ▲
                           │
                     Component tests
                  Real component behavior
                           ▲
                           │
                        Unit tests
            Pure functions / deterministic logic
```

Do not use one layer as evidence for another.

Examples:

```text
Unit test ≠ proof that the UI works
Component callback test ≠ proof of responsive CSS
Mocked integration ≠ proof of live backend behavior
Source-string SQL test ≠ proof that PostgreSQL enforces the constraint
```

---

# 4. Confirmed Strong Area — Pure Unit Tests

## `src/test/workspace/resourceAdapter.test.ts`

This is currently a strong testing pattern.

It exercises real pure behavior such as:

```text
- project isolation
- data normalization
- metadata extraction
- deterministic sorting
- search/filter behavior
- identity preservation
- empty inputs
```

### Classification

```text
✅ Strong and appropriate
```

### Preserve

Continue testing pure functions with exact behavioral assertions. Avoid replacing these with shallow `toBeDefined()`-style checks.

---

# 5. Workspace Navigation Tests — Valid Technique, Incomplete Coverage

## `src/test/workspace/ProjectWorkspaceNavigation.test.tsx`

The resource-switching regression tests improved substantially because the Editor/SystemArchitect test doubles model mount-only internal state:

```tsx
const [title] = React.useState(document.title);
```

This is a legitimate way to reproduce the lifecycle bug that required resource-specific React keys.

### What this proves

```text
ProjectWorkspace orchestration
→ URL/resource switch
→ resource-specific lifecycle boundary
```

### What it does not prove

It still mocks:

```text
Editor
SystemArchitect
useDocuments
useSystemDesigns
```

Therefore it does not fully prove the complete runtime chain:

```text
ProjectWorkspace
 → real Editor
 → actual editor state

ProjectWorkspace
 → real SystemArchitect
 → real React Flow/canvas state
```

### Classification

```text
✅ Good regression technique
🟡 Incomplete integration coverage
```

### Required improvement

Keep the focused mocked regression tests, but add a small higher-fidelity integration or E2E path for the critical user-visible behaviors:

```text
Document A → Document B
Design A → Design B
```

The final assertions should verify the **rendered resource**, not only URL state.

---

# 6. Navigation Hook Tests Do Not Fully Prove History Semantics

## `src/test/workspace/useWorkspaceNavigation.test.tsx`

Current tests mainly verify query strings such as:

```text
?doc=doc-123
?design=des-456
```

But the product contract distinguishes:

```text
Open resource         → push
Switch resource       → push
Internal Back         → replace
Canonicalization      → replace
Invalid resource      → replace
Action consumption    → replace
```

### Classification

```text
🟡 Contract coverage incomplete
```

### Required tests

Test actual traversal:

```text
Overview
  ↓ push
Doc A
  ↓ push
Doc B
  ↓ push
Design C
  ↓ Browser Back
Doc B
  ↓ Browser Back
Doc A
  ↓ Browser Forward
Doc B
```

Also explicitly verify that internal editor/architect Back uses replace semantics.

---

# 7. Sidebar Tests Are Coupled to the Old UX Contract

## `src/test/workspace/ProjectWorkspaceSidebar.test.tsx`

Current tests assert the old model:

```text
Documents
System Designs
```

with type-first navigation and type-specific creation controls.

The new product model is:

```text
Project
 ├── Folders / Areas
 │    ├── Documents
 │    └── Designs
 └── Root
```

### Classification

```text
🟡 Tests need legitimate contract revision when Folder UX is implemented
```

### Critical rule

Do not merely edit assertions until they pass.

First establish the new product contract, then test it.

Required future coverage:

```text
folder renders
folder count is correct
folder expands/collapses
resources appear in correct folder
Document + Design coexist in same folder
Root resources remain visible
resource selection works
search works
folder actions work
```

If an old assertion is changed, record whether that change is:

```text
CONTRACT CHANGE
TEST BUG FIX
TEST FIDELITY IMPROVEMENT
```

---

# 8. Layout Test Does Not Prove Responsive Behavior

## `src/test/workspace/ProjectWorkspaceLayout.test.tsx`

The existing mobile test essentially proves:

```text
click hamburger
→ callback receives true
```

That proves event wiring, not actual responsive behavior.

It does not establish:

```text
viewport < breakpoint
→ sidebar hidden
→ mobile header shown
→ drawer opens
→ selecting resource closes drawer
→ main content uses available width
→ no horizontal overflow
```

### Classification

```text
🟡 Useful callback test
🟡 Not a responsive-system proof
```

### Required improvement

Use a realistic responsive integration/E2E test for at least one critical mobile journey.

---

# 9. The 50 Docs + 20 Designs Test Is Not a Performance Test

The current test creates:

```text
50 documents
20 designs
```

and verifies that the workspace renders without error.

This proves:

```text
70 mock resources do not crash this test composition
```

It does **not** prove:

```text
smooth rendering
low interaction latency
low memory use
virtualization
performance scalability
```

### Classification

```text
🟡 Valid smoke/integrity test
❌ Not performance evidence
```

Reframe or rename it accordingly.

If performance becomes a requirement, create a separate measurement strategy.

---

# 10. Major E2E False-Positive Risk — Conditional Visibility

Current E2E files include patterns equivalent to:

```ts
if (await button.isVisible()) {
  await button.click();
  ...
}
```

This creates a severe false-positive path:

```text
Required UI missing
      ↓
isVisible() = false
      ↓
body skipped
      ↓
test ends
      ↓
PASS
```

### Classification

```text
🔴 Test-design defect
```

### Required rule

For required product behavior:

```text
Expected feature missing
      ↓
FAIL
```

Use explicit required assertions such as:

```ts
await expect(locator).toBeVisible();
await locator.click();
```

Conditional execution is allowed only when optionality is genuinely part of the product contract and that optionality is documented.

---

# 11. Security E2E Must Exercise Artix's Security Boundary

An example currently injects HTML into a manually-created DOM element using `textContent`.

That demonstrates a browser API property:

```text
textContent does not interpret HTML
```

It does not demonstrate that an actual Artix rendering path safely handles malicious input.

### Classification

```text
🔴 Wrong system boundary for the claimed security property
```

### Required improvement

Exercise the actual product path, for example:

```text
real user input
→ Artix state/storage
→ real Artix rendering path
→ inspect resulting DOM / execution state
```

The test must validate the application's behavior, not an unrelated browser primitive.

---

# 12. Static SQL String Tests Are Not Runtime Database Tests

Some security tests read migration files and assert that strings such as:

```text
REFERENCES auth.users(id)
ON DELETE CASCADE
```

exist in the SQL.

That is a **source audit**.

It does not prove:

```text
migration applies
constraint exists in DB
RLS blocks unauthorized access
foreign key behavior is correct at runtime
```

### Classification

```text
🔴 Source audit mislabeled as runtime verification
```

### Required plan

The agent must inspect the repository's available DB test infrastructure.
Then choose the strongest practical boundary:

```text
A. Local/isolated Supabase DB test
B. Deterministic integration test database
C. If neither exists: keep source audit but label it honestly and document
   the runtime boundary as unverified
```

Do not claim runtime DB coverage when it does not exist.

---

# 13. Global Test Setup / Mock Boundary

Current test setup globally mocks Supabase Edge Function invocation.

This is useful for hermetic unit/integration tests.

But it means those tests exercise:

```text
Vitest
 ↓
mocked FunctionsClient
 ↓
test
```

not:

```text
Vitest / browser
 ↓
real Edge Function
 ↓
real remote service
```

### Classification

```text
✅ Legitimate isolation
🟡 Boundary must be stated accurately
```

Tests should not be described as live backend verification when they use this mock.

---

# 14. Legacy Persistence Tests Need Classification

The suite still tests legacy components such as:

```text
tabCloseGuard
tabSync
```

These areas are not part of the eventual Local-First target architecture.

Do not delete them automatically.

Classify each as:

```text
legacy regression coverage
still-required architecture-independent behavior
obsolete behavior
```

Then decide whether it should be:

```text
preserved
isolated as legacy coverage
rewritten
removed with explicit justification
```

The suite should not accidentally imply that deprecated architecture is part of the target system contract.

---

# 15. E2E Configuration Audit

Current Playwright configuration provides a useful foundation:

```text
Chromium
Firefox
WebKit
trace on first retry
screenshot on failure
video on failure
local dev server
```

The agent must still verify:

```text
- Are E2E tests actually executed in CI?
- Are all intended browser projects executed in CI?
- Is authentication deterministic?
- Are test data/resources deterministic?
- Do tests depend on developer-local state?
- Are required UI paths allowed to silently skip?
- Which external network calls are intentionally mocked?
```

Do not treat the existence of `playwright.config.ts` as proof that meaningful E2E coverage exists in CI.

---

# 16. Test Integrity Rules

## Allowed

```text
✅ Add focused tests
✅ Add realistic stateful mocks
✅ Improve selectors
✅ Replace obsolete assertions when the product contract intentionally changes
✅ Add integration/E2E coverage
✅ Add deterministic fixtures
```

## Prohibited

```text
❌ Delete assertions to make tests pass
❌ Skip tests to hide failures
❌ Add `.only` to bypass the suite
❌ Replace exact behavioral assertions with weak existence checks
❌ Use conditional visibility checks for required features
❌ Change test configuration to prevent execution of failures
❌ Modify unrelated tests merely to restore green status
```

Any existing test modification must be explicitly categorized:

```text
CONTRACT CHANGE
TEST BUG FIX
TEST FIDELITY IMPROVEMENT
```

---

# 17. Required Agent Deliverable Before Code Changes

The agent must first produce a **Test Correctness Validation Report** containing:

```text
1. Test architecture currently present
2. Tests inspected
3. Production files compared against them
4. Findings confirmed
5. Findings rejected
6. Newly discovered false-positive risks
7. Missing critical coverage
8. Tests that should remain unchanged
9. Tests that require legitimate modification
10. New tests required
11. Recommended implementation order
```

Use evidence from the actual local codebase.

Do not invent coverage.

---

# 18. Required Implementation Plan Format

After validation, the agent must produce a plan with:

## Goals

What confidence gaps will be eliminated?

## Reasoning

Why does the current test not prove the desired behavior?

## Restrictions

What production behavior and existing test guarantees must remain protected?

## Approach

Which layer should test each invariant?

```text
Unit
Component
Integration
E2E
Database integration (where feasible)
```

## Code Edits

Exact files to:

```text
create
modify
remove
```

## Test Matrix

For each requirement:

```text
Requirement
→ Test type
→ File
→ Test setup
→ Expected behavior
```

## Verification

At minimum:

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
npm run test:e2e
```

plus any database-specific command actually supported by the repository.

---

# 19. Priority Order

Prioritize by risk, not by raw test count.

### P0 — False Positives

Fix required E2E paths that can silently skip.

### P1 — Critical Workspace Behavior

Strengthen:

```text
Document A → B
Design A → B
URL ↔ displayed resource
Browser history
```

### P2 — Folder Feature Coverage

Add:

```text
folder creation
folder persistence
membership
move
move-to-root
delete-folder preservation
search
```

### P3 — Security Boundary Fidelity

Test real application paths rather than browser primitives.

### P4 — Database Runtime Verification

Use the strongest practical DB boundary available.

### P5 — Legacy Test Classification

Clarify what belongs to the current contract versus deferred architecture.

---

# 20. Critical Workspace Testing Philosophy

For a resource-switching requirement, the minimum meaningful proof is:

```text
User action
    ↓
URL changes
    ↓
resource selection resolves
    ↓
sidebar active state changes
    ↓
main content changes to the same resource
```

Not merely:

```text
URL changed
```

For Document B:

```text
URL = ?doc=B
Sidebar = B
Editor visibly represents B
```

For Design B:

```text
URL = ?design=B
Sidebar = B
SystemArchitect visibly represents B
```

---

# 21. Critical Folder Testing Philosophy

For:

```text
Authentication
├── Auth PRD
└── Auth Architecture
```

tests should prove the correct invariants at the correct layers:

```text
Folder exists
Folder persists
Document membership persists
Design membership persists
Both types coexist
Move changes membership
Move-to-root sets folder_id = null
Deleting folder preserves resources
Refresh preserves membership
Search respects the hierarchy
```

A UI-only test cannot prove database persistence.
A database test cannot prove sidebar presentation.

Use the correct test layer for each invariant.

---

# 22. Acceptance Criteria for Test-System Improvement

The test-system improvement is complete only when:

```text
[ ] Required E2E tests fail when required UI is absent.
[ ] No required E2E flow silently skips because an element is missing.
[ ] Workspace navigation tests prove displayed resource identity, not only URL.
[ ] Browser history semantics are explicitly tested.
[ ] Folder behavior is covered at appropriate layers.
[ ] Security tests exercise real Artix boundaries where practical.
[ ] DB tests are not described as runtime verification unless they execute against a DB.
[ ] Legacy tests are explicitly classified.
[ ] Meaningful existing tests remain meaningful.
[ ] Every modified existing test has a recorded reason.
[ ] No test configuration is weakened to obtain green status.
[ ] Full suite passes.
[ ] lint passes.
[ ] TypeScript passes.
[ ] build passes.
[ ] E2E passes where configured.
```

---

# 23. Final Agent Instruction

```text
Do not immediately rewrite the tests.

First inspect the actual local working tree and compare it against this report.
Confirm which findings are true, reject inaccurate findings, and identify any
additional test-fidelity problems.

Then produce a concrete implementation plan.

When implementing:
- Preserve meaningful existing coverage.
- Never weaken tests merely to make them pass.
- Use the strongest reasonable test layer for each invariant.
- Prefer behavior verification over implementation-detail verification.
- Use mocks only for legitimate boundaries.
- Do not claim coverage the test does not actually provide.
- Do not change production code merely to satisfy a flawed test.
- Do not push before local verification.

Final implementation report must list:
Production files changed:
Tests added:
Tests modified:
Tests deleted:
Test configuration changed:
False-positive risks fixed:
New coverage added:
Existing coverage preserved:
Commands executed:
Results:
Remaining known limitations:
```

---

# 24. Core Principle

The test suite should answer:

> **Could this important behavior be broken while all tests still pass?**

For critical product behavior, the desired answer is:

```text
No.
```

not merely:

```text
The test runner is green.
```
