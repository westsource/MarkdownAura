; Installer hooks for the Windows package (IMPL.md §12).
;
; Windows will not let a process set the default handler for a file type: since Windows 8 the per-user
; choice lives in `FileExts\.md\UserChoice`, protected against exactly this kind of write. The installer
; cannot do it either — what it *can* do is register the association (tauri does, through
; `bundle.fileAssociations`) and leave a marker saying "offer this on first launch".
;
; The app reads that marker once and clears it, then opens the *Open with* dialog on a real document —
; where the choice actually belongs: one click, and the "Always use this app" box is right there. On
; Linux none of this is needed, because `xdg-mime default` can simply be told.
;
; The marker lives under HKCU because the installer is per-user by default; the app reads the same hive.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegDWORD HKCU "Software\MarkdownAura" "OfferDefaultApp" 1
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\MarkdownAura" "OfferDefaultApp"
  DeleteRegKey /ifempty HKCU "Software\MarkdownAura"
!macroend
