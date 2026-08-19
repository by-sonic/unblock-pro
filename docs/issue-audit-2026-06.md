# Issue audit: June 2026

This audit compares the open UnblockPro issues with Flowseal/zapret-discord-youtube
1.9.9c and bol-van/zapret at commit `1a1fc38c8ea05b481eebcbd338df48cdcca23c15`.

## Addressed in this update

| Issues | Root cause | Change | Verification needed |
| --- | --- | --- | --- |
| #17, #31 | Auto-selection accepted partial connectivity: a thumbnail or one Discord endpoint could pass while video/CDN traffic stayed blocked. | Require YouTube Web plus `redirector.googlevideo.com`, Discord API plus a real CDN asset, and the Discord gateway WebSocket on Windows. macOS uses the same required HTTP probes through SOCKS. | Confirm against at least two Russian ISPs. |
| #19, #23, #44, #46 | UnblockPro contained hand-reconstructed, older variants of Flowseal profiles and missed recent Discord payload changes. | Generate and ship all 20 `general*.bat` profiles from Flowseal 1.9.9c, including ALT12. Keep uniquely named experimental profiles only as fallback. | Confirm voice, CDN and video playback, not just landing pages. |
| #20, #25, #26 | Releases contained an empty `bin` directory and required a second GitHub download on first connect. | Bundle the audited Flowseal Windows runtime and a compiled universal macOS `tpws` in release artifacts. Network download remains a fallback. | Install on clean Windows and macOS accounts without a pre-existing user-data directory. |
| #18, #22, #37, #48 | macOS could copy Linux `binaries/aarch64/tpws` and try to execute it as a macOS program. Runtime fallback also ran `make`, not `make mac`. | Build universal Mach-O `tpws` in macOS CI from a pinned zapret commit. Reject ELF by magic header and use `make mac` for fallback compilation. | Test Intel, Apple Silicon, Tahoe and Golden Gate. |
| #39 | A process killed by a signal has `exitCode=null`; that raw value was shown as the error. | Report the termination signal or a real numeric exit code. | Reproduce by terminating `tpws` from Activity Monitor. |
| #34, #21 | Unsigned macOS apps cannot reliably replace themselves through Electron's signed update path. | Stop presenting a broken restart flow. macOS now reports the available version and opens the release page for manual installation; Windows keeps automatic installation. | Verify update notification and release link. |
| #28, #41, #43 | Custom domains were poorly documented and only take effect after the active process reloads its hostlist. | Preserve custom domains in generated lists and document the UI/reconnect requirement. | Test one domain absent from the built-in lists on both platforms. |
| #29 | Working upstream strategies disappeared between releases. | The complete pinned Flowseal strategy set is now generated as a snapshot and regression-tested. | Confirm manual selection persists across an app update. |

## Root cause found after this audit

The audit above treated "ни одна стратегия не сработала" as a strategy-content
problem. It was not. The strategy-selection loop cleared the module-level process
handle from the `close` handler of an already-killed process, so a late event
from strategy N wiped the handle belonging to the running strategy N+1. That
strategy was then reported as "не запустился" while its process stayed alive
holding port 1080, which made every later strategy fail to bind. **The whole run
degraded after the first strategy that did not pass.** Reproduced on a copy of
the logic: of 4 iterations, 2 falsely skipped and 2 processes leaked.

That single defect accounts for the cluster #48, #44, #37, #19 ("ни одна не
сработала"), #22, #18 ("тестирует только одну"), #42 (accumulated processes
burning CPU) and #31 (system SOCKS pointing at a process from a different
strategy). Packaging fixes in #49 did not touch it, which is why 2.0.19 did not
help.

| Issues | Change |
| --- | --- |
| #48, #44, #37, #19, #22, #18 | Generation-token process ownership; termination waits for the real exit; the port is verified free before each spawn; stray `tpws`/`winws` are reaped. |
| #42 | Same fix — the CPU load was accumulated orphans, not one hot process. |
| #39 | A signal is reported as a signal, and the binary is checked for an executable slice for this CPU before the loop runs, with ad-hoc signing attempted after a SIGKILL. |
| #46, #23 | The `/etc/hosts` block is versioned and refreshed, so a rotated Discord voice address is no longer pinned forever. |
| #16 | Orphaned engine processes after quit are gone; closing to tray stays deliberate, and the tray now shows and can cancel a running search. |

## Second-pass review findings

Three independent reviews of the fix branch found the fix itself incomplete.
All three were reproduced against the shipped functions before being changed.

| Finding | Why it mattered |
| --- | --- |
| `removeMarkedBlock` ended the hosts block at the first blank line, but the payload contains one. | Only half the block was removed; the rest stayed unmarked, was duplicated on every version bump, and — being *above* the fresh block under first-match-wins resolution — kept the stale address winning. The anti-stale versioning delivered nothing, and a user line appended below the block was silently deleted while the integrity guard reported success. |
| The orphan fix covered only macOS, inside a single non-reentrant call. | `requestedExecutionLevel: requireAdministrator` means most Windows users take the built-in loop, which still nulled the handle before confirming exit (so the shared safety net never saw the process), waited a fixed 3s per strategy, and had no generation gate on the connected-process handler. |
| `startProxy()` was reentrant and uncoordinated with `stopProxy()`. | The tray "Подключить" item stayed clickable for the whole search, so two loops could share the port and kill each other's attempts; a quit or disconnect mid-search left the loop spawning processes, or committing a strategy and re-enabling the system proxy after the user had left. |

## Still unverified

Nothing in this work has been exercised on live macOS or Windows hardware — only
unit tests and reproduction scripts. Before publishing a release, run
`scripts/verify-mac.sh` against `main` and the fix branch and compare: false
"не запустился" (about half the list on `main`, ~0 after), peak concurrent
`tpws` (>1 on `main`, always 1 after), and `tpws` alive after quit (0).

## Known technical debt (separate tickets)

| Item | Risk |
| --- | --- |
| `winws.exe` is launched elevated from `%APPDATA%`, writable by any unprivileged process as the same user, and its SHA-256 is checked only at download time. | A one-time substitution is re-executed with Administrator rights on every connect. Pre-existing, not introduced by the strategy-loop work. |
| `HOSTS_URL` is fetched from a third party's moving `main` branch with no commit pin, unlike the zapret binary source. | Content merged into `/etc/hosts` with elevated rights is not pinned. |
| The listener on port 1080 is verified to exist, not to be our process. | A local process that wins the bind race could receive proxied traffic. |

## Product or platform requests

| Issues | Decision |
| --- | --- |
| #35 | Android requires a separate application and networking stack; not part of the Electron desktop release. |
| #36 | Roblox support needs target IP/domain discovery and is not implied by Discord/YouTube profiles. |
| #40 | Per-resource strategy testing needs a configurable probe URL and safety validation; track as a feature. |
| #33 | Current Electron releases do not support Windows 7. Supporting it would require a separate legacy build and WinDivert package. |
| #30 | Integration with another bypass project is a separate product decision. |

## Upstream update policy

Run `npm run sync:flowseal` after fetching `Flowseal/zapret-discord-youtube` into
the local `flowseal/main` ref. The generated snapshot records the exact upstream
version and commit. CI tests assert the strategy count, names, placeholders,
profile structure, bundle version and required payload files.
