; D101 initial choices. Afterwards app toggles own the settings; update never resets them.
!include LogicLib.nsh
!include FileFunc.nsh
Var P1Fresh
Var P1Desktop
Var P1StartMenu
Var P1Autostart
Var P1Dialog
Var P1DesktopBox
Var P1StartBox
Var P1AutostartBox

Function P1InitialChoices
  StrCpy $P1Fresh 1
  StrCpy $P1Desktop 1
  StrCpy $P1StartMenu 1
  StrCpy $P1Autostart 1
  ReadRegDWORD $0 HKCU "Software\PLUR1BUS\DesktopInstaller" "Initialized"
  ${If} $0 == 1
    StrCpy $P1Fresh 0
  ${Else}
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\PLUR1BUS" "DisplayVersion"
    ${If} $0 != ""
      StrCpy $P1Fresh 0
    ${EndIf}
  ${EndIf}
  ${GetOptions} $CMDLINE "/NODESKTOP" $0
  ${IfNot} ${Errors}
    StrCpy $P1Desktop 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/NOSTARTMENU" $0
  ${IfNot} ${Errors}
    StrCpy $P1StartMenu 0
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/NOAUTOSTART" $0
  ${IfNot} ${Errors}
    StrCpy $P1Autostart 0
  ${EndIf}
  ClearErrors
  ; Also detect an ordinary newer installer invocation, not just /UPDATE.
  ${If} $P1Fresh == 0
    StrCpy $UpdateMode 1
  ${EndIf}
FunctionEnd

Function P1OptionsPage
  ${If} $P1Fresh == 0
    Abort
  ${EndIf}
  ${If} $PassiveMode == 1
    Abort
  ${EndIf}
  IfSilent p1_options_skip
  !insertmacro MUI_HEADER_TEXT "PLUR1BUS" "Options / Optionen"
  nsDialogs::Create 1018
  Pop $P1Dialog
  ${If} $P1Dialog == error
    Abort
  ${EndIf}
  ${NSD_CreateCheckbox} 0 12u 100% 18u "Desktop icon / Desktop-Symbol"
  Pop $P1DesktopBox
  ${NSD_SetState} $P1DesktopBox $P1Desktop
  ${NSD_CreateCheckbox} 0 40u 100% 18u "Start menu / Startmenü"
  Pop $P1StartBox
  ${NSD_SetState} $P1StartBox $P1StartMenu
  ${NSD_CreateCheckbox} 0 68u 100% 18u "Start PLUR1BUS with Windows / Mit Windows starten"
  Pop $P1AutostartBox
  ${NSD_SetState} $P1AutostartBox $P1Autostart
  nsDialogs::Show
  Return
  p1_options_skip:
  Abort
FunctionEnd
Function P1OptionsLeave
  ${NSD_GetState} $P1DesktopBox $P1Desktop
  ${NSD_GetState} $P1StartBox $P1StartMenu
  ${NSD_GetState} $P1AutostartBox $P1Autostart
FunctionEnd
Function P1SaveInitialChoices
  ${If} $P1Fresh == 0
    Return
  ${EndIf}
  WriteRegDWORD HKCU "Software\PLUR1BUS\DesktopInstaller" "Initialized" 1
  WriteRegDWORD HKCU "Software\PLUR1BUS\DesktopInstaller" "DesktopIcon" $P1Desktop
  WriteRegDWORD HKCU "Software\PLUR1BUS\DesktopInstaller" "StartMenu" $P1StartMenu
  WriteRegDWORD HKCU "Software\PLUR1BUS\DesktopInstaller" "Autostart" $P1Autostart
  ${If} $P1Autostart == 1
    ReadRegStr $0 HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PLUR1BUS"
    ${If} $0 == ""
      WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "PLUR1BUS" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --autostart'
      WriteRegStr HKCU "Software\PLUR1BUS\DesktopInstaller" "OwnedAutostart" '$\"$INSTDIR\${MAINBINARYNAME}.exe$\" --autostart'
    ${EndIf}
  ${EndIf}
FunctionEnd
