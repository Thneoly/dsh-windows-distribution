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
- `--build-version auto` synthesizes a service-free local version (`<upstream-version>.<UTC date>.local<time>`) following the same rule as the CI workflow; upstream remote version discovery is never contacted.
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

### Local build-host pitfalls (verified 2026-10-26/27)

1. **Run the build from PowerShell, not Git Bash.** Upstream packaging spawns `tar`; Git Bash resolves it to GNU tar, which interprets `D:\w\...` as a remote `host:path` and fails. Reordering PATH to prefer `System32\tar.exe` inside Git Bash instead hijacks `bash` to the WSL launcher (`System32\bash.exe`) and breaks npm's shell scripts. PowerShell gives the same tool resolution semantics as the CI runner.
2. **Keep build caches and TEMP outside the repository tree.** electron-builder caches CommonJS helper scripts and executes them with Node; if the cache directory sits under any ancestor `package.json` with `"type": "module"`, those scripts die with `require is not defined in ES module scope`. Point `ELECTRON_BUILDER_CACHE`, `ELECTRON_CACHE`, `pnpm_config_store_dir`, `npm_config_cache`, `PIP_CACHE_DIR`, `TEMP` and `TMP` at directories outside the repo (and off the system drive if desired).
3. **Use a physically short workspace path.** The `lxml` native DLL load fails once resolved paths approach 260 characters; clone to something like `D:\w` (equivalent in length to the CI runner's `C:\w`).

### Commands

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

The Windows workflow copies the checked-out source to the genuinely short physical path `C:\w` before packaging. The previous `SUBST`-drive approach did not work: Node/Electron tooling canonicalized the alias back to the original `D:\a\...` workspace, so the `lxml` DLL load still failed. A physical copy keeps the build process rooted at `C:\w`; the workflow prints the actual Node working directory, checks the expected `lxml` extension path is below 240 characters, and copies successful artifacts back to the original GitHub workspace for upload. The Office-conversion smoke test remains enabled.

Open **Actions → Windows unsigned installer → Run workflow**. Select `build-only` (the default) when the application services are not ready; it requires no service URLs and produces a clearly marked non-distributable artifact. Select `configured-test` only when the actual download origin, mandatory-update origin, and approved login origin are available. The workflow generates a unique SemVer build version from the pinned DSH release, UTC date, workflow run number, and attempt.

The unsigned installer and provenance files are uploaded as a workflow artifact for 14 days. The workflow does not sign, publish a GitHub Release, or upload to a download service.

## Automated post-install smoke test

Before uploading the workflow artifact, the Windows runner silently installs the generated EXE into a unique temporary directory and verifies the installed payload rather than only inspecting the unpacked build directory. It checks the installer and manifest SHA-256 values, the installed Electron shell and ASAR, the DSH runtime descriptor and version, the standalone Node.js/Python/pnpm executables, and the Office conversion CLI. It invokes the packaged Node and Python executables by absolute path, checks their pinned versions, and imports `lxml.etree`, `python-docx`, `openpyxl`, and `python-pptx` using the packaged Python. The temporary installation is removed after the checks.

This smoke test runs on the Windows packaging runner, which itself has build tools installed. It proves the installed payload contains executable bundled runtimes; it does **not** replace a clean-VM test with system Node.js/Python/pnpm absent, nor does it test login or automatic updates.

## Output and verification

Output is written to:

```text
.build/artifacts/<build-version>/
  deepseek-harness-<build-version>-win-x64-unsigned.exe
  desktop-distribution.json
  desktop-distribution.lock.json
  release-manifest.json
  SHA256SUMS.txt
```

`desktop-distribution.json` describes the versioned built-in component set; `desktop-distribution.lock.json` pins each payload file digest. The build adapter stages the declared bundle into the pinned upstream workspace, updates the workspace dependency lock with the pinned pnpm version, and refuses to emit a release manifest unless the bundle is present in the prepared DSH runtime and its payload digests match. `release-manifest.json` records the upstream release/tag/commit, build mode, toolchain versions, component IDs, component lock digest, patched upstream pnpm-lock digest, artifact sizes, and SHA-256 digests. `SHA256SUMS.txt` covers the packaged files and the release manifest.

The manifest currently sets `customDistributionComponentsIncluded: false`: this milestone proves the pinned upstream Windows build and artifact provenance. The next milestone must stage and activate the distribution's built-in plugins/workflows/tools before that flag can become true. User-managed extensions must remain outside immutable application resources and must survive upgrades independently.

## Limitations

- This is an unsigned test installer. Windows SmartScreen may warn; do not treat it as a production release.
- The `build-only` artifact intentionally cannot log in or update. The `configured-test` profile requires actual HTTPS origins supplied by the operator; the project does not invent or provision an update/download service.
- A successful build is not a substitute for installing and testing the EXE on a clean Windows x64 VM.
- Built-in custom component integration and end-user extension migration tests are not yet implemented.
