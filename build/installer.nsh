; Install-time hardening.
;
; The app refuses to run its engine as administrator out of a directory an
; ordinary account can modify (windows-protected-runtime.js). Installing over an
; existing folder keeps that folder's ACL, so a folder that once inherited write
; access for Authenticated Users stayed refused on every reinstall (#73). The
; installer runs elevated (oneClick + perMachine) and has just written every
; file itself, so it pins an explicit ACL: SYSTEM and Administrators full,
; Users and app packages read/execute, nothing inherited from the parent.
; SIDs instead of names so localized Windows resolves them too.

!macro customInstall
  nsExec::ExecToLog 'icacls "$INSTDIR" /setowner *S-1-5-32-544 /T /C /Q'
  Pop $0
  nsExec::ExecToLog 'icacls "$INSTDIR" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX *S-1-15-2-1:(OI)(CI)RX /T /C /Q'
  Pop $0
!macroend

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
