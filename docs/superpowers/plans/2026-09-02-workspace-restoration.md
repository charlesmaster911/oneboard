# OneBoard Workspace Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore authenticated Team KPI, Operations Manual, and owner Settings screens using the data and documents already present in OneBoard.

**Architecture:** Add narrowly scoped backend routes for authenticated manual documents and workspace KPI data, then render those APIs in the existing static frontend. Keep secrets and manuals out of the frontend build; settings uses the current encrypted platform-credential APIs and sync status endpoints.

**Tech Stack:** Node.js, Express, PostgreSQL, vanilla ES modules, Vitest/jsdom, Node test runner, Supertest

**Spec:** `docs/superpowers/specs/2026-09-02-oneboard-restoration-live-data-design.md`

## Global Constraints

- Preserve the existing Google authentication and role policy.
- Never copy `manuals/` into the frontend `dist/` directory.
- Render manual content through safe DOM nodes; never inject untrusted markdown with `innerHTML`.
- Settings is owner-only; Team KPI and manuals are available to authenticated human roles.
- Preserve all existing Team Work and Meeting Minutes behavior.

---

### Task 1: Authenticated manual catalog and document routes

**Files:**
- Create: backend `services/manualLibrary.js`
- Create: backend `routes/manuals.js`
- Modify: backend `app.js`
- Test: backend `test/manuals.test.js`

**Interfaces:**
- Produces: `createManualsRouter({ manualLibrary })`
- Produces: `manualLibrary.list()` and `manualLibrary.read(fileName)`

- [ ] **Step 1: Write failing route tests**

Test that no token gets 401, an authenticated member gets the 21-item sanitized catalog, a valid filename returns text, and traversal/unknown filenames return 404 without paths.

- [ ] **Step 2: Run the route test and verify RED**

Run: `node --test test/manuals.test.js`
Expected: FAIL because `/api/manuals` is not mounted.

- [ ] **Step 3: Implement an allowlisted filesystem library and authenticated routes**

Use a fixed metadata catalog mapped to resolved repository files. `read()` accepts only catalog filenames and returns `{ file, title, category, summary, content }`.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test test/manuals.test.js`
Expected: all manual route tests pass.

### Task 2: Workspace KPI API

**Files:**
- Create: backend `routes/kpi.js`
- Modify: backend `app.js`
- Test: backend `test/kpi.test.js`

**Interfaces:**
- Produces: `GET /api/kpi/team?from=YYYY-MM-DD&to=YYYY-MM-DD`
- Returns: `{ range, totals, byAssignee }` with counts and completion percentages

- [ ] **Step 1: Write failing KPI behavior tests**

Use literal task fixtures to verify completion rate, overdue count, important-open count, unassigned grouping, and workspace isolation.

- [ ] **Step 2: Run and verify RED**

Run: `node --test test/kpi.test.js`
Expected: FAIL with route not found.

- [ ] **Step 3: Implement the tenant-scoped aggregation route**

Query tasks for the requested range and compute integers in JavaScript so null/empty behavior is explicit.

- [ ] **Step 4: Run and verify GREEN**

Run: `node --test test/kpi.test.js`
Expected: all KPI tests pass.

### Task 3: Restore six-section navigation and authenticated renderers

**Files:**
- Modify: frontend `index.html`
- Modify: frontend `modules/dom.js`
- Modify: frontend `app.js`
- Modify: frontend `style.css`
- Test: frontend `test/restored-sections.test.js`

**Interfaces:**
- Consumes: `/kpi/team`, `/manuals`, `/manuals/:file`, `/admin/platforms`, `/sync/status`
- Produces: visible `kpi`, `manual`, and owner-only `settings` sections

- [ ] **Step 1: Write failing DOM tests**

Verify navigation policy, KPI cards/table, manual search and text-only body rendering, platform status cards, owner-only credential forms, and keyboard-visible controls.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- restored-sections.test.js`
Expected: FAIL because restored sections do not exist.

- [ ] **Step 3: Add semantic markup and minimal renderers**

Reuse existing OneBoard tokens. Create safe nodes with `createElement`/`textContent`; expose clear empty/error states and last-updated labels.

- [ ] **Step 4: Run and verify GREEN**

Run: `npm test -- restored-sections.test.js`
Expected: restored section tests pass.

### Task 4: Settings mutations and sync controls

**Files:**
- Modify: frontend `app.js`
- Test: frontend `test/settings.test.js`

**Interfaces:**
- Consumes: `POST /admin/platforms/:name`, `GET /admin/oauth/cafe24/start`, `POST /sync`
- Produces: owner credential save and manual sync controls with accessible status messages

- [ ] **Step 1: Write failing interaction tests**

Verify secrets are never re-rendered, empty forms are rejected client-side, a successful save refreshes summaries, and manual sync shows accepted range without claiming completion.

- [ ] **Step 2: Run and verify RED**

Run: `npm test -- settings.test.js`
Expected: FAIL because the interactions are missing.

- [ ] **Step 3: Implement the interactions**

Send only non-empty fields, clear secret inputs after success, refresh status cards, and use fixed Korean action messages.

- [ ] **Step 4: Run and verify GREEN**

Run: `npm test -- settings.test.js`
Expected: settings tests pass.

### Task 5: Workspace restoration regression gate

**Files:**
- Modify: frontend `scripts/build-config.js` only if a new public ES module is added
- Modify: relevant deployment tests

- [ ] **Step 1: Run backend tests**

Run: `npm test`
Expected: all backend tests pass.

- [ ] **Step 2: Run frontend tests and production build**

Run: `npm test && GOOGLE_CLIENT_ID=test-client-id ONEBOARD_API_BASE=https://oneboard-free-api.onrender.com/api npm run build`
Expected: all frontend tests pass and `dist/` contains no manual source files.
