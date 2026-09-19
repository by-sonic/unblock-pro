# Runtime and strategy investigation — 2026-09-19

The maintainer authorized merging and publishing the prepared release, and asked
whether upstream zapret updates explain user reports. This supersedes the
earlier no-release scope recorded in `issue-resolution-2026-09.md`.

## Findings

- Windows bundle/profile snapshot was Flowseal 1.9.9c. Latest stable checked
  upstream is [1.10.2](https://github.com/Flowseal/zapret-discord-youtube/releases/tag/1.10.2),
  commit `dfd8e613b099676cf2aa7b474ee5923801514dec`.
- The Windows executable/driver blobs did not change between these two bundles;
  the relevant changes are strategies, payloads and lists. Updating only
  `winws.exe` would not deliver them.
- Imported BAT arguments retained the `^!` cmd escape. Direct process launch
  passed the caret literally, so FAKE TLS AUTO profiles could interpret it as
  a missing payload filename and exit. The importer now produces `!`, and the
  legacy batch launcher disables delayed expansion around launch to preserve it.
  A native cmd argv test covers initial launch and partial-strategy restart.
- macOS used commit `1a1fc38c8ea05b481eebcbd338df48cdcca23c15`.
  Upstream [d437963](https://github.com/bol-van/zapret/commit/d437963452674faadfd45adcd62466272b5a2fcd)
  removes the small custom resolver-thread stack on macOS, following reports of
  stack-related crashes. This is a concrete candidate for #70, not proof of the
  reporter's crash without its `.ips` report.
- A bare `--help` check and numeric SOCKS CONNECT do not exercise the resolver.
  CI must send an actual SOCKS domain-name CONNECT to `localhost` to cover that
  path, accepting the expected local-address policy refusal.
- [zapret2](https://github.com/bol-van/zapret2) is a separate packet engine with
  different configuration and no macOS tpws replacement. A blind binary swap is
  not an upgrade path for this app.

## Implementation and release plan

1. Windows owner: update pinned bundle, complete payload manifest, strategy/list
   snapshots and sync script together. Verify downloaded archive SHA-256.
2. macOS owner: pin resolver fix and exercise domain resolver in the local SOCKS
   smoke test. Keep source, local build and CI on the identical commit.
3. Integrator: consume common lists, remove duplicated CI version/checksum,
   document update policy, prepare accurate release notes and publish after
   independent review and both CI builds.
4. Local verification: observe existing network before starting a scoped test.
   The user's Windows initially had an active AmneziaVPN tunnel and no running
   UnblockPro/winws process. Results over that tunnel cannot establish ISP bypass.
   No VPN change without the user's direction; keep DNS/hosts unchanged.

Runtime updates remain reviewed and pinned to releases. App auto-update installs
the new runtime/profile set on Windows; macOS updates are installed manually.
The program does not execute arbitrary new upstream code in the background.
SHA checks and compatibility tests remain mandatory.

## Release gates

- Independent code/security review completed. Both discovered pipeline defects
  were repaired: platform builds explicitly disable publication, and a tag must
  match package.json. All build jobs and the release target share the exact SHA
  emitted after the version bump.
- Local full suite and real Electron renderer smoke pass; npm audit reports zero
  vulnerabilities. Exact counts and hosted run are recorded in PR #68.
- Windows CI validates every imported strategy with the verified bundle using
  parse-only `--dry-run` before packaging. macOS CI compiles both CPU slices,
  signs the runtime ad hoc, and performs the DNS-path SOCKS smoke.
- Local ISP testing is pending the user's explicit message that VPN is off.
  The VPN has not been disabled by this task.
