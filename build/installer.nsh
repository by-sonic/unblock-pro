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
;
; The ACL is set on the folder itself only, and everything below is reset to
; inherit it. 2.0.24 and 2.0.25 applied the (OI)(CI) grants with /T instead:
; on files icacls drops those ACEs after /inheritance:r has already removed the
; inherited ones, so every installed file was left with an empty DACL. Nobody,
; not even an elevated administrator, could read UnblockPro.exe, its resources
; or the uninstaller, so the app did not start, could not be updated and could
; not be uninstalled (#79).

!macro customInstall
  nsExec::ExecToLog 'icacls "$INSTDIR" /setowner *S-1-5-32-544 /T /C /Q'
  Pop $0
  nsExec::ExecToLog 'icacls "$INSTDIR" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX *S-1-15-2-1:(OI)(CI)RX /C /Q'
  Pop $0
  nsExec::ExecToLog 'icacls "$INSTDIR\*" /reset /T /C /Q'
  Pop $0
!macroend

; Repair for installs left unreadable by 2.0.24/2.0.25 (#79). It has to run
; before the old version is uninstalled: electron-builder copies and runs the
; old uninstaller from the install folder, and that file is unreadable too.
; Resetting to the inherited Program Files ACL is enough to get through; the
; ACL above is pinned again once the new files are in place. The owner is
; Administrators, so the elevated installer may rewrite the DACL even though
; it cannot read the files. Only an existing UnblockPro folder is touched.

!macro customInit
  ${if} $INSTDIR != ""
    ${if} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${orIf} ${FileExists} "$INSTDIR\resources\app.asar"
      nsExec::ExecToLog 'icacls "$INSTDIR" /reset /T /C /Q'
      Pop $0
    ${endIf}
  ${endIf}
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
