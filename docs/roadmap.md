# MVP roadmap

## P0 — Repository bootstrap

- [x] Establish repository purpose and architecture boundaries.
- [x] Pin the local Node.js development baseline.
- [x] Add manifest and upstream runtime-lock validators with unit tests.
- [ ] Review the bootstrap PR and merge.

## P1 — Inspect and adapt upstream

- [ ] Pin the exact upstream DSH commit used for the first Windows build.
- [ ] Confirm current desktop packaging scripts, runtime descriptor generation and installer/update behavior at that commit.
- [ ] Add an adapter that consumes upstream `scripts/primary-runtime/lock.json`, `pnpm-lock.yaml`, Electron package metadata and existing runtime descriptors without duplicating their authority.
- [ ] Record the exact Electron-embedded Node.js version from the built Electron runtime.

## P2 — Compose a release

- [ ] Define production `desktop-distribution.json` and `desktop-distribution.lock.json` generation.
- [ ] Package one real built-in plugin, one workflow and one tool end-to-end.
- [ ] Validate all files and dependency edges before invoking the upstream Windows packager.
- [ ] Keep user extensions and user data outside immutable release resources.

## P3 — Windows acceptance

- [ ] Build unsigned Windows x64 installer in CI or a Windows build host.
- [ ] Install and run on a clean Windows x64 VM without system Node.js, Python or pnpm.
- [ ] Test corrupted/missing artifact rejection and user-extension preservation across upgrade.
- [ ] Add signing and production publishing only after credentials and release policy are configured.

## Out of scope for the first MVP

- A plugin marketplace.
- Independent automatic updates of built-in components.
- A replacement Electron desktop shell.
- Guaranteed automatic rollback of the complete previous binary installation.
