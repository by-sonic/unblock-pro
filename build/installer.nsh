; Uninstall-time cleanup.
;
; The app writes a block of pinned Discord voice addresses into the hosts file.
; hosts wins over DNS, so a block left behind keeps breaking Discord after the
; app is gone - including under a VPN. The running app removes it on disconnect;
; this covers the case where it never got the chance.
;
; The uninstaller already runs elevated (oneClick + perMachine), so no extra
; prompt appears. Failures are ignored on purpose: a hosts file we could not
; clean must not block the uninstall.

!macro customUnInstall
  nsExec::ExecToLog 'powershell -ExecutionPolicy Bypass -NoProfile -File "$INSTDIR\resources\uninstall-clean-hosts.ps1"'
  Pop $0
!macroend
