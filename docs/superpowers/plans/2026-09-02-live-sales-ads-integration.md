# OneBoard Live Sales and Ads Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collect real sales and advertising metrics with current provider contracts, surface trustworthy sync state, and automate the approved 09:00/16:00 schedule.

**Architecture:** Keep each provider client behind the existing `collect(dateFrom, dateTo)` boundary but make failures explicit. Extend operational handlers with the authenticated Drive sales importer, return per-platform sync outcomes, and expose freshness/status data to the frontend.

**Tech Stack:** Node.js, Axios, provider REST APIs, PostgreSQL, Google Drive API, Node test runner

**Spec:** `docs/superpowers/specs/2026-09-02-oneboard-restoration-live-data-design.md`

## Global Constraints

- No mock or sample metrics may enter production `daily_metrics`.
- A provider error must not be converted into a successful zero row.
- The existing schedules remain exactly 09:00 and 16:00 Asia/Seoul.
- Kakao Talk Store and Kakao Gift sales enter through authenticated Drive files until an official seller API exists.
- Existing encrypted credential storage and role boundaries remain unchanged.

---

### Task 1: Provider contract validation

**Files:**
- Create: backend `services/platformDefinitions.js`
- Modify: backend `routes/admin.js`
- Modify: backend `routes/platforms.js`
- Test: backend `test/platform-definitions.test.js`

**Interfaces:**
- Produces: `PLATFORM_DEFINITIONS` with label, kind, required fields, identifiers, and connection method
- Produces: sanitized validation errors for missing required fields

- [ ] **Step 1: Write failing definition and validation tests**

Verify each supported direct platform has exact required fields and that partial updates may merge with existing encrypted values but a new connection cannot omit required fields.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/platform-definitions.test.js`
Expected: FAIL because definitions/validation do not exist.

- [ ] **Step 3: Implement shared definitions and validation**

Keep labels and field metadata non-secret; never return stored secret values.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/platform-definitions.test.js`
Expected: all definition tests pass.

### Task 2: Correct sales provider clients

**Files:**
- Modify: backend `integrations/cafe24.js`
- Modify: backend `integrations/naver_store.js`
- Modify: backend `integrations/coupang.js`
- Test: backend `test/sales-integrations.test.js`

**Interfaces:**
- Produces: `collect(from, to)` returning one normalized metric per successfully queried date
- Throws fixed provider errors for authentication, transport, schema, or pagination failure

- [ ] **Step 1: Write failing HTTP-boundary tests**

With provider-shaped fixtures, verify current auth/signature inputs, pagination, paid-order sales calculation, canceled/returned exclusion, and failure propagation.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/sales-integrations.test.js`
Expected: current clients fail contract and failure-propagation cases.

- [ ] **Step 3: Implement minimal current provider behavior**

Use documented endpoints and normalize numeric fields. Persist refreshed Cafe24 tokens through an injected callback rather than mutating only process memory.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/sales-integrations.test.js`
Expected: sales integration tests pass.

### Task 3: Correct advertising provider clients

**Files:**
- Modify: backend `integrations/meta.js`
- Modify: backend `integrations/naver_ads.js`
- Modify: backend `integrations/kakao.js`
- Test: backend `test/ad-integrations.test.js`

**Interfaces:**
- Produces: normalized spend, impressions, clicks, conversions, conversion revenue and ROAS
- Throws on provider/report failures; returns zero only for a successful empty report

- [ ] **Step 1: Write failing report-contract tests**

Verify Meta daily insights parsing, Naver Search Ads official service host/report fields, Kakao Moment report endpoint, and empty-success versus failure behavior.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/ad-integrations.test.js`
Expected: current clients fail endpoint and swallowed-error cases.

- [ ] **Step 3: Implement corrected clients**

Keep provider details inside each client and return only normalized metrics plus non-secret provenance.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/ad-integrations.test.js`
Expected: ad integration tests pass.

### Task 4: Wire Drive sales and truthful job outcomes

**Files:**
- Refactor: backend `integrations/drive_sync.js`
- Modify: backend `jobs/operationalHandlers.js`
- Modify: backend `jobs/jobRegistry.js`
- Modify: backend `server.js`
- Test: backend `test/drive-sync.test.js`
- Test: backend `test/operationalHandlers.test.js`

**Interfaces:**
- Produces: `syncDriveSales()` normalized step result
- Morning job includes `channel-import` after direct sales and before ads

- [ ] **Step 1: Write failing Drive and registry tests**

Verify tenant-scoped upserts for `kakao_talk_store` and `kakao_gift`, idempotency, no move on partial parse failure, and explicit skipped result when configuration is absent.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/drive-sync.test.js test/operationalHandlers.test.js`
Expected: FAIL because Drive is not wired to the operational job.

- [ ] **Step 3: Inject dependencies and wire the job**

Remove module-level environment/database capture, sanitize file results, and add a recognized `channel-import` step/reason code.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/drive-sync.test.js test/operationalHandlers.test.js`
Expected: Drive/job tests pass.

### Task 5: Freshness/status API and dashboard semantics

**Files:**
- Modify: backend `routes/sync.js`
- Modify: backend `routes/data.js`
- Modify: frontend `app.js`
- Test: backend `test/sync-status.test.js`
- Test: frontend `test/sales-status.test.js`

**Interfaces:**
- Produces: platform status with `connectionState`, `syncState`, `recordsSynced`, `completedAt`, and `freshness`
- Dashboard consumes status to distinguish actual zero from unavailable data

- [ ] **Step 1: Write failing API and UI tests**

Verify missing credentials, failed sync, never-synced, fresh zero, and fresh nonzero states render distinct labels and do not alter numeric totals.

- [ ] **Step 2: Run and verify RED**

Run backend: `node --test test/sync-status.test.js`
Run frontend: `npm test -- sales-status.test.js`
Expected: both fail because status semantics are missing.

- [ ] **Step 3: Implement status join and UI state strip**

Join supported platform definitions with latest logs and credentials; show status actions next to the dashboard source badge and in Settings.

- [ ] **Step 4: Run and verify GREEN**

Run the same backend and frontend commands.
Expected: status tests pass.

### Task 6: Full verification and live deployment

**Files:**
- Modify: repository docs only if runbook fields changed

- [ ] **Step 1: Run all backend tests**

Run: `npm test`
Expected: zero failures.

- [ ] **Step 2: Run all frontend tests and production build**

Run: `npm test && GOOGLE_CLIENT_ID=test-client-id ONEBOARD_API_BASE=https://oneboard-free-api.onrender.com/api npm run build`
Expected: zero failures and successful build.

- [ ] **Step 3: Push both branches and wait for Render deployment**

Confirm backend health and frontend asset HTTP 200 after deployment.

- [ ] **Step 4: Perform authenticated live QA**

Verify six-section navigation, manual search/read, KPI values, settings status, safe credential entry behavior, manual sync acceptance, desktop/mobile layout, and zero OneBoard-origin console errors. Do not report completion until the live checks pass.
