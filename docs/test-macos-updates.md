# Mac test release signing and upgrade acceptance

This workflow targets only `com.fangtang.app.test`, the test account configuration,
and Mac artifacts under the OSS `test/` prefix. Production builds, `stable/`, and
other test-platform feeds remain unchanged.

## Without an Apple Developer certificate

Unsigned Mac test builds detect new versions automatically and offer the matching
DMG for manual installation. They never offer a restart action that cannot apply
the update. This is not automatic installation and does not disable signature
verification or change system trust.

The signed workflow continues to reject missing credentials instead of silently
publishing unsigned output. Ordinary test candidates can still use the existing
Release workflow with `channel=test`, `signed_test_macos=false`, and `publish=false`.
After acceptance of the manual path, publish only the corresponding test Mac files.
Do not describe that result as successful signing or automatic installation.
`fangtangMacAutoUpdate` is true only for the signed test build path; Windows and
Linux ignore this Mac-specific setting.

## Credentials

Configure these secrets in the **office-test-macos** GitHub environment of
`fangtang-ai/fangoffice`, or as repository secrets with the same names. Never commit
certificates or passwords, or paste private keys into chat.

| Secret                                 | Value                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `TEST_MAC_CSC_LINK`                    | Single-line base64 of a Developer ID Application `.p12` containing its private key |
| `TEST_MAC_CSC_KEY_PASSWORD`            | Password used to export the `.p12`                                                 |
| `TEST_MAC_CSC_NAME`                    | Full identity, such as `Developer ID Application: Company (TEAMID)`                |
| `TEST_MAC_APPLE_ID`                    | Apple ID authorized to notarize for that team                                      |
| `TEST_MAC_APPLE_APP_SPECIFIC_PASSWORD` | Its app-specific password                                                          |
| `TEST_MAC_APPLE_TEAM_ID`               | Matching 10-character Team ID                                                      |

Publication reuses the existing `OSS_RELEASE_AK_ID` and `OSS_RELEASE_AK_SECRET`.
Do not change production secrets. Missing Apple credentials must fail preflight.
Ad-hoc signing, self-signed certificates, disabling Gatekeeper, or disabling
signature verification cannot replace a company Developer ID.

## Signed candidates and publication

Start from the already registered **Release** workflow on the candidate branch:

```sh
gh workflow run release.yml --repo fangtang-ai/fangoffice \
  --ref <candidate-branch> \
  -f channel=test -f signed_test_macos=true \
  -f expected_version=<candidate-version> -f publish=false
```

The shell manifest and lockfile versions must match, and the candidate must be
newer than the published test Mac version. `publish=false` produces only the
`signed-test-macos` CI artifact. `publish=true` publishes test Mac files.
The signed path skips the unsigned build matrix and never creates a production
GitHub Release. `release-test-macos.yml` supports both direct dispatch and calls
from the existing Release workflow.

Required gates:

1. Full CI tests, type checking, native engines, and Electron e2e.
2. Actual Developer ID signatures, Apple notarization, and stapling.
3. Extract the distributed ZIP and verify its version, test bundle ID, Team ID,
   test account URL, test updater URL, and absence of local overrides.
4. Run `codesign --verify --deep --strict`, `xcrun stapler validate`, and
   `spctl --assess`. Verify the DMG signature and notarization ticket too.
5. Check update-feed SHA512 values against the actual installers. Upload the
   Mac installers first; switch `test/latest-mac.yml` only after anonymous access
   and size checks succeed.
6. Read the public new feed, and compare all three stable feeds plus the test
   Windows/Linux feeds byte for byte before and after publication.

The artifact gate can also run directly on macOS:

```sh
APPLE_TEAM_ID=<expected-team> node scripts/verify-test-macos-release.cjs \
  --artifacts <staged-ci-artifacts> --version <candidate-version>
```

## Upgrade acceptance

### Existing unsigned 0.9.14 / 0.9.15 installations

Try the actual old updater and record its result. A feed, downloaded ZIP, or
restart button does not prove successful installation. These old packages fail
signature verification and may be unable to transition through Squirrel.

If Squirrel rejects the old app, manually replace the test app using the first
notarized DMG. Record this as initial signature migration, not an automatic
upgrade. Preserve the existing test application's `userData` directory, login,
projects, chat, knowledge libraries, and user files.

### Signed baseline to a newer build signed by the same team

1. Install a verified signed baseline and sign in. Keep a synthetic document
   and an existing knowledge space, and record the account and version.
2. Build a newer version with the same Developer ID, Team ID, and test bundle
   ID. Do not overwrite prior installers or modify stable feeds.
3. Start the baseline and allow its initial 15-second check. Running clients
   recheck every four hours; a normal quit/relaunch triggers the startup check.
   Downloads and restart require user action, not silent replacement.
4. Observe the actual new version, download it, and select restart/install.
5. After restart, verify the new version in About and inspect the installed
   bundle's signature, ticket, bundle ID, Team ID, and test updater URL.
6. Confirm that the account, document, projects, and knowledge library remain.
   Repeated launches must neither reinstall the same version nor downgrade.

Record both stages independently. Without credentials or an actual restart into
the new version, mark automatic installation incomplete. Mock updater events or
copying an app manually cannot substitute for that acceptance.

References: [Electron signing requirements](https://www.electronjs.org/docs/latest/api/auto-updater#macos),
[electron-builder signing](https://www.electron.build/v26/docs/features/code-signing/).
