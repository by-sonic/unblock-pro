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

## Needs more evidence

| Issue | Current assessment | Next diagnostic |
| --- | --- | --- |
| #42 | A single report of 297% CPU is not enough to identify Electron, `tpws`, or repeated reconnects as the owner. | Capture Activity Monitor process hierarchy, selected strategy, app log and a 30-second sample. |
| #16 | Closing the frameless window intentionally hides the app in the tray so bypass remains active. | Decide whether the close button should quit, or add a `Minimize to tray` preference. |

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
