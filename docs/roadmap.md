# MVP roadmap

## P0 — Repository bootstrap

- [x] Establish repository purpose and architecture boundaries.
- [x] Pin the local Node.js development baseline.
- [x] Add manifest and upstream runtime-lock validators with unit tests.
- [x] Review the bootstrap PR and merge.

## P1 — Inspect and adapt upstream

- [x] Pin latest published upstream release `v0.2.1-rc.3` (`dsh-v0.2.1-rc.3`) to commit `1f81c047fc48fa190a683e469daa699857e9afe8`.
- [ ] Confirm current desktop packaging scripts, runtime descriptor generation and installer/update behavior at the pinned commit.
- [ ] Add an adapter that consumes upstream `scripts/primary-runtime/lock.json`, `pnpm-lock.yaml`, Electron package metadata and existing runtime descriptors without duplicating their authority.
- [ ] Record the exact Electron-embedded Node.js version from the built Electron runtime.

## P2 — Compose a release

- [x] Define production `desktop-distribution.json` and `desktop-distribution.lock.json` generation.
- [x] Package one real built-in plugin, one workflow and one tool end-to-end.
- [x] Validate all component files and dependency edges against the committed lock before invoking the upstream Windows packager.
- [ ] Keep user extensions and user data outside immutable release resources.

## P3 — Windows baseline build

- [x] Add a Windows x64 build orchestrator that verifies the pinned DSH checkout and exact build-host Node.js/Python/pnpm versions.
- [x] Add a manual Windows Actions workflow for an unsigned test installer, with explicit HTTPS origin inputs and artifact provenance/SHA-256 output.
- [x] Add a service-free `build-only` profile that embeds only reserved `.invalid` origins and marks the artifact non-distributable.
- [x] Run the default build-only workflow and inspect the generated installer/provenance bundle.
- [x] Add a Windows workflow step that installs the generated EXE and verifies the bundled runtime before publishing the workflow artifact.
- [x] Pass a Windows build with the new post-install smoke test enabled. (verified locally on Windows x64, 2026-10-27; CI rerun pending)
- [ ] Install and verify the packaged runtime on a clean Windows x64 VM without system Node.js, Python or pnpm.
- [ ] Configure real test-service origins and repeat the functional login/update tests when those services exist.

## P4 — Distribution components and upgrade safety

- [x] Validate the version-locked plugin/workflow/tool bundle injection end-to-end in a complete Windows installer build.
- [ ] Keep built-in component resources immutable and user extensions/configuration in separate user-owned storage.
- [ ] Test corrupted/missing component rejection, upgrade preservation, and rollback behavior.
- [ ] Add signing and production publishing only after credentials and release policy are configured.

## Out of scope for the first MVP

- A plugin marketplace.
- Independent automatic updates of built-in components.
- A replacement Electron desktop shell.
- Guaranteed automatic rollback of the complete previous binary installation.
