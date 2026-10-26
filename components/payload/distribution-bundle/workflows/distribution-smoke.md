# Distribution bundle smoke workflow

- **Workflow ID:** `distribution-smoke`
- **Workflow version:** `1.0.0`
- **Purpose:** Verify that the distribution bundle and its workflow resources were installed from the same immutable release.

## Steps

1. Call `distribution_bundle_info`.
2. Confirm the reported bundle is `@thneoly/dsh-distribution-bundle` and its version is `1.0.0`.
3. Confirm `distribution-smoke` appears in the bundled workflow list.
4. Report the observed bundle version, workflow version, and whether all checks passed.

## Safety

This workflow is read-only. It does not access credentials, make network requests, install packages, modify user files, or change the active DSH profile.
