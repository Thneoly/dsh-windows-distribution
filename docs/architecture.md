# Architecture and boundaries

## Scope

This repository is a distribution/build companion for the upstream DSH Desktop project. It is not a fork of the Harness runtime and does not replace Electron or the existing updater.

Upstream repository: https://github.com/deepseek-ai/deepseek-harness

## Pinned upstream baseline

The first build baseline is the latest published upstream GitHub Release verified on 2026-10-26: `v0.2.1-rc.3`, tag `dsh-v0.2.1-rc.3`, commit `1f81c047fc48fa190a683e469daa699857e9afe8`. It is a prerelease, not a stable release. See [`../upstream.lock.json`](../upstream.lock.json) for immutable release metadata and Git blob SHAs of key lock/config files. The build must check out the exact commit and must not use `master` or a floating tag.

## Runtime layers

1. **Build toolchain**: Node.js used by developers and CI. This repository pins it in `.node-version`.
2. **Electron runtime**: the Node.js runtime embedded by the exact Electron version. Record the actual version observed from the packaged Electron binary; do not assume it equals the primary runtime.
3. **Primary runtime payload**: standalone Node.js, Python, pnpm and Python wheels prepared by the upstream `scripts/primary-runtime/lock.json`.
4. **Application dependencies**: JavaScript dependency graph resolved by upstream `pnpm-lock.yaml`, installed with frozen-lockfile semantics.
5. **Distribution components**: built-in plugins, workflow definitions and tools pinned by a release manifest and lock file.
6. **User extensions/data**: user-managed plugins, workflows, tools, profiles, secrets and work data stored outside immutable release resources.

## Source-of-truth rules

- Do not copy upstream runtime pins into a second editable source of truth. Read the upstream runtime lock and embed its digest plus the verified resolved versions in release metadata.
- `pnpm-lock.yaml` is authoritative for the JavaScript dependency graph.
- Electron version determines the Electron-embedded Node.js runtime; validate it from the actual packaged binary.
- The upstream primary-runtime lock at the pinned commit is authoritative for the standalone Node.js, Python artifacts and Python wheels. `upstream.lock.json` records its Git blob SHA as a source identity; the build adapter must additionally compute SHA-256 for the downloaded file before packaging.
- The distribution lock is authoritative for the exact built-in component set and file digests.
- Any change to a pinned artifact or built-in component produces a new distribution release.

## Version-locked built-in components

The repository's `components/desktop-distribution.json` is the human-edited declaration. `components/desktop-distribution.lock.json` records the exact SHA-256 of every declared payload file and the upstream runtime identity. CI verifies that the lock matches the declaration, that every payload file is listed exactly once in the inventory, and that no unlisted files or symlinks are present.

The Windows build adapter verifies the pinned upstream checkout first, then stages the local bundle into the upstream workspace, adds it as a dependency of the DSH CLI package, and registers it in DSH's installation-owned optional-bundle catalog. It regenerates the upstream pnpm lock with the pinned pnpm version before performing the normal frozen install. The build must verify that the resulting runtime contains the bundle package, the compiled optional-bundle catalog, and the exact locked payload before it can mark `customDistributionComponentsIncluded: true` in release provenance.

The initial `@thneoly/dsh-distribution-bundle` is intentionally a small acceptance bundle: it provides read-only tools for reporting the bundled component version and reading a version-locked workflow recipe. It ships with the installer but is switched off until the user enables it through DSH's existing optional-bundle manager. User-installed extensions remain in the profile/user-owned area and are not overwritten by a release upgrade.

## Integrity and execution

SHA-256 detects unexpected content changes but does not establish publisher identity. Production release artifacts must also be signed and verified against a trusted signing identity. A digest does not sandbox executable code: third-party extensions require explicit trust and permission policy.

Builds fail closed when a required artifact is missing, a digest mismatches, a component dependency is unresolved, or the target platform/architecture does not match.

## Update and rollback boundary

The first MVP validates release metadata and builds a deterministic component inventory. It should integrate with the existing upstream update flow rather than creating a competing updater. Automatic binary rollback after a failed first launch is a separate enhancement requiring a tested previous-version installation strategy; it must not be claimed until implemented and tested.
