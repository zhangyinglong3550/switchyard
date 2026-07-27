# Mobile File Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Safely deliver Agent-produced workspace files in mobile chat, bound uploaded attachment retention, improve attachment feedback, and make Android release verification repeatable.

**Architecture:** Extend the existing opaque asset store instead of adding a second file service. Structured `file_delivery` events and `tool.files` use the same workspace-constrained registration path. Upload assets remain private copies and are pruned only when expired and unreferenced; workspace assets remain references and are never deleted by cleanup.

**Tech Stack:** Node.js built-ins, Electron Mobile Control service, vanilla mobile PWA, Gradle Android application.

## Global Constraints

- Only current-session workspace regular files may be delivered; no arbitrary paths, directories, external URLs, or path inference from model text.
- Mobile APIs keep device-token auth, same-origin validation, `private, no-store`, and `nosniff`.
- Upload copies are private (`0600` / `0700`), TTL defaults to 7 days, and workspace source files are never deleted.
- No parser dependency is added: text-like attachments are injected as text; unsupported binary formats fail clearly.
- Android signing values must stay outside Git.

---

### Task 1: Asset provenance, expiry and bounded cleanup

**Files:**
- Modify: `apps/desktop/src/mobile-control/store.mjs`
- Modify: `packages/core/test/mobile-control-foundation.test.mjs`

**Interfaces:**
- Produces `putAttachment({...})` metadata with `source`, `createdAt`, `updatedAt`, `expiresAt`.
- Produces `registerWorkspaceFile({... source, deliveryAt })` and `pruneAssets()`.

- [ ] Write failing tests for expired unreferenced uploads being deleted, referenced uploads being retained, and workspace assets never being deleted.
- [ ] Run `node --test packages/core/test/mobile-control-foundation.test.mjs` and verify the new cases fail before implementation.
- [ ] Add asset provenance, timestamp fields, reference collection, expiry/size pruning, and call pruning from load/write/read paths.
- [ ] Re-run the focused test file and verify it passes.
- [ ] Commit the storage change.

### Task 2: Structured explicit file delivery

**Files:**
- Modify: `apps/desktop/src/mobile-control/dto.mjs`
- Modify: `apps/desktop/src/mobile-control/session-registry.mjs`
- Modify: `packages/core/test/mobile-session-registry.test.mjs`

**Interfaces:**
- Consumes runtime events `{ type: "file_delivery", delivery: { path, name?, mimeType? } }`.
- Produces projected event `{ delivery: Asset }`, with a workspace-constrained `source: "delivery"` asset.

- [ ] Write a failing registry test for an in-workspace delivery and an out-of-workspace delivery rejection/no path leakage.
- [ ] Run `node --test packages/core/test/mobile-session-registry.test.mjs` and verify the new case fails.
- [ ] Normalize `delivery` DTO data and register it using the same workspace file validator as `tool.files`.
- [ ] Re-run the focused test file and verify it passes.
- [ ] Commit the delivery change.

### Task 3: Attachment UX and input validation feedback

**Files:**
- Modify: `apps/mobile/app.js`
- Modify: `apps/mobile/styles.css`
- Modify: `packages/core/test/mobile-pwa-structure.test.mjs`
- Modify: `apps/desktop/src/mobile-control/session-registry.mjs`
- Modify: `packages/core/test/mobile-control-server.test.mjs`

**Interfaces:**
- Consumes public asset `source`, timestamps, expiration state and delivery metadata.
- Produces source/time/size labels, delivery cards, and clear upload type/aggregate-size errors.

- [ ] Write failing structure/server tests for delivery card metadata and unsupported binary attachment errors.
- [ ] Run focused PWA/server tests and verify the new assertions fail.
- [ ] Add source/time labels, delivery rendering, upload quota feedback, and explicit server-side unsupported-binary errors.
- [ ] Re-run focused tests and verify they pass.
- [ ] Commit the UX change.

### Task 4: Android release verification and documentation

**Files:**
- Modify: `apps/android/app/build.gradle`
- Create: `apps/android/scripts/verify-release.sh`
- Modify: `apps/android/README.zh-CN.md`
- Modify: `package.json`
- Modify: `packages/core/test/workspace-manifests.test.mjs`

**Interfaces:**
- Produces `npm run android:release:check`, which invokes Gradle release assembly then validates package ID/version and reports signing state.

- [ ] Write a failing workspace manifest test for the verification script and release configuration contract.
- [ ] Run `node --test packages/core/test/workspace-manifests.test.mjs` and verify it fails.
- [ ] Add environment-driven version/signing config, verification script, npm command and Chinese release/true-device smoke-test documentation.
- [ ] Run the focused test and `npm run android:release:check`; report unsigned output when signing credentials are absent.
- [ ] Commit Android release support.

### Task 5: Integrated verification and packaging

**Files:**
- Modify: `docs/superpowers/specs/2026-07-27-mobile-file-delivery-design.md`

- [ ] Update the design status and record automated-vs-manual verification boundary.
- [ ] Run `npm run check` and `npm test`.
- [ ] Run `npm run desktop:dmg` and verify the app bundle contains the delivery code.
- [ ] Commit the verification/documentation update.
