# Open issue follow-up — 2026-09-19

Scope: all 11 open issues at the start of this audit. Prepare a reviewed PR and
reply to each reporter. The maintainer explicitly requested no merge or release.
Published version remains 2.0.20. The work starts at `origin/release/next`
(`8444644`), retaining the integrated changes from PRs #61–#68.

## Plan and ownership

1. Planner: compare main/release branches, read complete reports and comments.
2. Custom-target implementation: #40 URL-based selection on both platforms;
   #69 renderer layout. Owns main process integration, IPC, probes and renderer.
3. macOS implementation: #70 runtime smoke test and crash classification;
   owns process lifecycle helpers and macOS CI smoke.
4. Windows security implementation: #53 protected runtime selection and complete
   reference validation; owns runtime security helpers.
5. Integrator: dependency maintenance, renderer smoke, documentation, integration,
   independent review, tests and GitHub responses.

No application version or bypass wire protocol change. Changes to the criterion
used to select a strategy and to permitted Windows runtime locations are visible
behavior changes. Real ISP compatibility, UAC dialogs, update installation and
macOS 27 cannot be certified by Windows unit tests or a hosted macOS build.

## Evidence and disposition

| Issue | Evidence / implementation scope | Confirmation needed |
| --- | --- | --- |
| #40 | Add an explicit HTTPS target criterion, hostlist inclusion and honest service status. | Real target and ISP acceptance after release. |
| #46 | Prior hosts cleanup and pinned data fixes retained. | Discord login and UDP voice on the reporter's provider. |
| #53 | Hash comparison alone leaves a check/use race; reject incomplete references and select a protected installed runtime. | Installed Windows launch and UAC smoke. |
| #54 | PR #68 bundles hosts data pinned to a commit and hash. | Release delivery. |
| #55 | Electron 43 remains supported; refresh to 43.7.3 and repair three newly reported transitive dependency advisories. | Update installation and native UI on macOS. |
| #56 | Partial service selection and exportable persistent logs retained. | App version and provider reproduction from author. |
| #58 | Latest author reply says YouTube already works; Discord is the actual requirement. Partial YouTube success does not resolve this report. | Discord-specific diagnostics. |
| #59 | Partial service selection and per-endpoint failures retained. | Actual bypass on affected macOS/provider combinations. |
| #60 | Fixed masked macOS cleanup failures, await stop/quit, cleanup after failed searches/crashes, late elevation callbacks and repeated DNS restoration. Uninstaller retained. | Release delivery and installed uninstaller smoke. |
| #69 | Reproduced domains card shrinking to 2px. Cards now retain intrinsic height in the scrolling pane. | Passed six real renderer layouts. |
| #70 | Attached RTF shows tpws listening then crashing repeatedly. AMFI denying a core dump does not establish a code-signing cause. | tpws .ips crash report from macOS 27 and affected-machine retest. |

## Validation

- Before changes: 179/179 unit tests passed.
- Initial fresh npm audit: three high advisories (`@xmldom/xmldom`, `fast-uri`,
  `js-yaml`). Compatible transitive updates remove all three.
- Electron support/release references:
  https://releases.electronjs.org/schedule and
  https://releases.electronjs.org/release/v43.7.3.
- Prepared in [PR #68](https://github.com/by-sonic/unblock-pro/pull/68).
- Local tests: 232/232 pass, including production-function VM tests for late
  callbacks, stop/quit ordering, failed cleanup, DNS and protected runtime paths.
- Real Electron 43.7.3: six layouts (420px wide, 560/680/900px tall, collapsed
  and expanded cards with long errors and an update banner), partial service
  status, target status/save, copy action, no renderer errors. Windows KnownDLL
  bootstrap confirmed from Electron main. Network/system APIs are fixtures.
- Fresh full `npm audit`: zero vulnerabilities. Syntax and whitespace checks pass.
- Independent code and security reviews completed; identified high-priority
  findings were fixed before requesting CI builds.
- Hosted CI verifies a compiled tpws SOCKS request path and packages macOS and
  Windows artifacts; the live run/result is linked from the PR. This is not a
  test of bypass on the affected ISPs or macOS 27/M4.

## Release verification still required

Keep affected-provider reports open until there is evidence of resolution.
Do not infer a working Discord voice connection from HTTPS/API probes. Do not
claim that #70's crash cause is fixed without the crash report or reproduction.
No production hosts, DNS, proxy or firewall settings are changed by this audit.
