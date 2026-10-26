# Windows unsigned installer build

This pipeline builds the pinned upstream DSH Desktop on a Windows x64 build host. It produces an **unsigned test installer**, not a production-signed release.

## Pinned build host

- Node.js: `24.21.0`
- Python (build host): `3.12.10`
- pnpm: `11.28.5`
- Git and the Windows C++/SDK toolchain required by Electron and native dependencies

The script checks the exact Windows build-host versions in `upstream.lock.json` → `buildHostToolchain`. The upstream `toolchain` block records the separate packaged runtime: its standalone Python remains `3.12.14`; that upstream runtime is built/downloaded separately and is not the Python interpreter installed on the Windows packaging host. The installed target computer does not need Node.js, Python, or pnpm.

## Build without application backend services

You can build the pinned installer before download, mandatory-update, or login services exist. Use the `build-only` profile:

- It generates a separate ignored file, `config/windows-build-only.env`.
- All application backend origins use the reserved `.invalid` domain, which is not a real service.
- The output manifest records `buildMode: unsigned-build-only`, `networkServicesConfigured: false`, and `distributionEligible: false`.
- The installer can be used to inspect packaging and verify installation/runtime files, but login and automatic updates are intentionally unavailable. Do **not** distribute it or use it as an upgrade source for real installations.

No real service URL or credential is needed for this profile. The build host still needs internet access to download the pinned source, locked dependencies, Electron, and runtime artifacts.

## Configure a connected test build

Use `configured-test` only after actual test services exist. The upstream Desktop requires valid HTTPS origins for its test download service and mandatory-update policy, including for unsigned builds. Do not use placeholder origins for an installer intended for functional login or update testing.

1. Run the build command once. If `config/windows.env` is missing, the script copies the pinned upstream `.env.windows.example` to `config/windows.env.example` and exits without building.
2. Copy `config/windows.env.example` to `config/windows.env`.
3. Fill in `DOWNLOAD_TEST_ORIGIN` and `DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN` with actual HTTPS origins (no path, query, or fragment).
4. Set `DSH_DESKTOP_MANDATORY_UPDATE_CONFIG` with the approved HTTPS login origin(s) for the test policy.
5. Set `DOWNLOAD_TEST_RELEASE_ID` to 32 lowercase hexadecimal characters. Reuse the same ID when testing upgrades across versions; use a new ID for an isolated test batch.

Both local config files are ignored by Git and are never copied into the artifact bundle. Unsigned packaging does not need EV signing credentials or upload credentials.

## Build locally on Windows x64

From the repository root:

```powershell
node --version
python --version
pnpm --version

npm run build:windows -- --profile build-only --check
npm run build:windows -- --profile build-only --build-version auto

# Only after the actual test services exist:
npm run build:windows -- --profile configured-test --config config/windows.env --check
npm run build:windows -- --profile configured-test --config config/windows.env --build-version auto
```

The first command checks the upstream config and the exact build-host toolchain after installing dependencies. The second builds the unsigned NSIS installer, runs the upstream packaged-runtime smoke test, and creates a local artifact bundle.

The script checks out the exact tag from `upstream.lock.json`, verifies the source commit and pinned Git blob identities, installs dependencies with `pnpm install --frozen-lockfile`, and calls the upstream `package:win:x64:unsigned` target.

## Build from GitHub Actions

The Windows workflow maps the repository workspace to a temporary short drive (`R:`) while packaging. On the hosted runner, the full nested path to the bundled `lxml` extension can reach roughly 253 characters before Windows loads its native DLL dependencies. The short drive keeps the same physical workspace and artifact location but reduces that path to about 201 characters. The workflow prints and checks this expected path length before building; it does not skip the Office-conversion smoke test.

Open **Actions → Windows unsigned installer → Run workflow**. Select `build-only` (the default) when the application services are not ready; it requires no service URLs and produces a clearly marked non-distributable artifact. Select `configured-test` only when the actual download origin, mandatory-update origin, and approved login origin are available. The workflow generates a unique SemVer build version from the pinned DSH release, UTC date, workflow run number, and attempt.

The unsigned installer and provenance files are uploaded as a workflow artifact for 14 days. The workflow does not sign, publish a GitHub Release, or upload to a download service.

## Output and verification

Output is written to:

```text
.build/artifacts/<build-version>/
  deepseek-harness-<build-version>-win-x64-unsigned.exe
  release-manifest.json
  SHA256SUMS.txt
```

`release-manifest.json` records the upstream release/tag/commit, build mode, toolchain versions, artifact sizes, and SHA-256 digests. `SHA256SUMS.txt` covers the packaged files and the release manifest.

The manifest currently sets `customDistributionComponentsIncluded: false`: this milestone proves the pinned upstream Windows build and artifact provenance. The next milestone must stage and activate the distribution's built-in plugins/workflows/tools before that flag can become true. User-managed extensions must remain outside immutable application resources and must survive upgrades independently.

## Limitations

- This is an unsigned test installer. Windows SmartScreen may warn; do not treat it as a production release.
- The `build-only` artifact intentionally cannot log in or update. The `configured-test` profile requires actual HTTPS origins supplied by the operator; the project does not invent or provision an update/download service.
- A successful build is not a substitute for installing and testing the EXE on a clean Windows x64 VM.
- Built-in custom component integration and end-user extension migration tests are not yet implemented.
