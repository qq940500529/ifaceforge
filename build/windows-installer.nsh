!macro IfgRegisterCliPath action
  InitPluginsDir
  Push $OUTDIR
  SetOutPath "$PLUGINSDIR"
  File /oname=ifg-cli-path.ps1 "${BUILD_RESOURCES_DIR}\windows-cli-path.ps1"
  Pop $R3
  SetOutPath "$R3"
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\ifg-cli-path.ps1" -Action "${action}" -Scope "$installMode" -InstallDirectory "$INSTDIR" -AppId "${APP_ID}" -ProductName "${PRODUCT_NAME}"'
  Pop $R3
  ${If} $R3 != "0"
    DetailPrint "Could not update the IfaceForge CLI registration. ($R3)"
    SetErrorLevel 3
    Abort
  ${EndIf}
  System::Call 'user32::SendMessageTimeoutW(p 0xffff, i 0x001a, p 0, w "Environment", i 2, i 1000, *p .r3) p'
!macroend

!ifdef BUILD_UNINSTALLER
  !macro customUnInstallSection
    Section "un.IfaceForge CLI"
      !insertmacro IfgRegisterCliPath uninstall
    SectionEnd
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
  !include "nsDialogs.nsh"

  Var IfgStartMenu
  Var IfgDesktop
  Var IfgStartMenuField
  Var IfgDesktopField

  !macro customPageAfterChangeDir
    Page custom IfgShortcutPage
    !define MUI_PAGE_HEADER_TEXT "$(IfgDetailsTitle)"
    !define MUI_PAGE_HEADER_SUBTEXT "$(IfgDetailsHint)"
    !define MUI_INSTFILESPAGE_FINISHHEADER_SUBTEXT "$(IfgDetailsHint)"
    !define MUI_INSTFILESPAGE_ABORTHEADER_SUBTEXT "$(IfgDetailsHint)"
    !define MUI_FINISHPAGE_NOAUTOCLOSE
  !macroend

  !macro IfgInstallStage text
    SetDetailsPrint both
    DetailPrint "${text}"
    SetDetailsPrint lastused
  !macroend

  !macro customFiles_x64
    ${IfNot} ${Silent}
      SetDetailsPrint listonly
      Push ""
      Call IfgReportInstalledFiles
      SetDetailsPrint lastused
    ${EndIf}
    !insertmacro IfgInstallStage "$(IfgRegisterApp)"
  !macroend

  !macro IfgReadShortcutOption flag selection
    ${GetOptions} $R0 "${flag}=" $R1
    ${IfNot} ${Errors}
      ${If} $R1 != "0"
      ${AndIf} $R1 != "1"
        MessageBox MB_OK|MB_ICONSTOP "$(IfgShortcutArgumentError) ${flag}=0 / ${flag}=1" /SD IDOK
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy ${selection} $R1
    ${EndIf}
    ClearErrors
  !macroend

  !macro customInit
    StrCpy $IfgStartMenu ${BST_CHECKED}
    StrCpy $IfgDesktop ${BST_UNCHECKED}
    ${GetParameters} $R0
    !insertmacro IfgReadShortcutOption "/STARTMENU" $IfgStartMenu
    !insertmacro IfgReadShortcutOption "/DESKTOP" $IfgDesktop
  !macroend

  !macro IfgApplyShortcut selection link
    ClearErrors
    SetDetailsPrint listonly
    ${If} ${selection} == ${BST_CHECKED}
      CreateShortCut "${link}" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ${IfNot} ${Errors}
        WinShell::SetLnkAUMI "${link}" "${APP_ID}"
        DetailPrint "$(IfgShortcutWritten) ${link}"
      ${Else}
        DetailPrint "$(IfgShortcutFailed) ${link}"
      ${EndIf}
    ${ElseIf} ${FileExists} "${link}"
      WinShell::UninstShortcut "${link}"
      ClearErrors
      Delete "${link}"
      ${IfNot} ${Errors}
        DetailPrint "$(IfgShortcutRemoved) ${link}"
      ${Else}
        DetailPrint "$(IfgShortcutFailed) ${link}"
      ${EndIf}
    ${EndIf}
    SetDetailsPrint lastused
    ClearErrors
  !macroend

  !macro customInstall
    ${If} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
      !insertmacro IfgInstallStage "$(IfgFileInstalled) ${UNINSTALL_FILENAME}"
    ${EndIf}
    !insertmacro IfgInstallStage "$(IfgConfigureShortcuts)"
    !insertmacro IfgApplyShortcut $IfgStartMenu $newStartMenuLink
    !insertmacro IfgApplyShortcut $IfgDesktop $newDesktopLink
    !insertmacro IfgInstallStage "$(IfgRegisterCli)"
    CreateDirectory "$INSTDIR\bin"
    ClearErrors
    FileOpen $R3 "$INSTDIR\bin\ifg.cmd" w
    IfErrors ifg_cli_failed
    FileWrite $R3 '@echo off$\r$\n'
    FileWrite $R3 'setlocal DisableDelayedExpansion$\r$\n'
    FileWrite $R3 'set "ELECTRON_RUN_AS_NODE=1"$\r$\n'
    FileWrite $R3 '"%~dp0..\${APP_EXECUTABLE_FILENAME}" "%~dp0..\resources\app.asar\dist\cli\main.js" %*$\r$\n'
    FileWrite $R3 'exit /b %errorlevel%$\r$\n'
    FileClose $R3
    IfErrors ifg_cli_failed
    !insertmacro IfgInstallStage "$(IfgFileInstalled) bin\ifg.cmd"
    !insertmacro IfgRegisterCliPath install
    Goto ifg_cli_done
    ifg_cli_failed:
      DetailPrint "$(IfgFileMissing) bin\ifg.cmd"
      SetErrorLevel 3
      Abort
    ifg_cli_done:
    StrCpy $launchLink "$appExe"
    ${If} ${FileExists} "$newStartMenuLink"
      StrCpy $launchLink "$newStartMenuLink"
    ${EndIf}
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
    !insertmacro IfgInstallStage "$(IfgInstallComplete)"
  !macroend
!endif

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    # Use the regular uninstaller cleanup for shortcuts created by this installer.
    !undef DO_NOT_CREATE_START_MENU_SHORTCUT
    !undef DO_NOT_CREATE_DESKTOP_SHORTCUT
  !else
    ShowInstDetails show
    LangString IfgShortcutTitle ${LANG_ENGLISH} "Shortcuts"
    LangString IfgShortcutSubtitle ${LANG_ENGLISH} "Choose where to open IfaceForge after installation."
    LangString IfgStartMenuLabel ${LANG_ENGLISH} "Create a Start menu shortcut"
    LangString IfgDesktopLabel ${LANG_ENGLISH} "Create a desktop shortcut"
    LangString IfgShortcutArgumentError ${LANG_ENGLISH} "Use 0 or 1 for each shortcut option."
    LangString IfgDetailsTitle ${LANG_ENGLISH} "Installation details"
    LangString IfgDetailsHint ${LANG_ENGLISH} "Right-click the details list to copy the installation activity."
    LangString IfgInstallTarget ${LANG_ENGLISH} "Install location"
    LangString IfgInstallUpgrade ${LANG_ENGLISH} "Preparing to replace the previous installation…"
    LangString IfgInstallFiles ${LANG_ENGLISH} "Installing application files…"
    LangString IfgFileInstalled ${LANG_ENGLISH} "Wrote file"
    LangString IfgFileMissing ${LANG_ENGLISH} "Could not verify written file"
    LangString IfgRegisterApp ${LANG_ENGLISH} "Registering IfaceForge with Windows…"
    LangString IfgRegisterCli ${LANG_ENGLISH} "Installing the matching ifg command and updating PATH…"
    LangString IfgConfigureShortcuts ${LANG_ENGLISH} "Applying shortcut choices…"
    LangString IfgShortcutWritten ${LANG_ENGLISH} "Wrote shortcut"
    LangString IfgShortcutRemoved ${LANG_ENGLISH} "Removed shortcut"
    LangString IfgShortcutFailed ${LANG_ENGLISH} "Could not update shortcut"
    LangString IfgInstallComplete ${LANG_ENGLISH} "Application files and installation settings are in place."

    LangString IfgShortcutTitle ${LANG_SIMPCHINESE} "快捷方式"
    LangString IfgShortcutSubtitle ${LANG_SIMPCHINESE} "选择安装后可从哪些位置打开 IfaceForge。"
    LangString IfgStartMenuLabel ${LANG_SIMPCHINESE} "创建开始菜单快捷方式"
    LangString IfgDesktopLabel ${LANG_SIMPCHINESE} "创建桌面快捷方式"
    LangString IfgShortcutArgumentError ${LANG_SIMPCHINESE} "快捷方式选项的值应为 0 或 1。"
    LangString IfgDetailsTitle ${LANG_SIMPCHINESE} "安装详情"
    LangString IfgDetailsHint ${LANG_SIMPCHINESE} "右键单击详情列表可复制安装记录。"
    LangString IfgInstallTarget ${LANG_SIMPCHINESE} "安装目录"
    LangString IfgInstallUpgrade ${LANG_SIMPCHINESE} "正在准备替换已有安装…"
    LangString IfgInstallFiles ${LANG_SIMPCHINESE} "正在安装程序文件…"
    LangString IfgFileInstalled ${LANG_SIMPCHINESE} "已写入文件"
    LangString IfgFileMissing ${LANG_SIMPCHINESE} "无法核对已写入文件"
    LangString IfgRegisterApp ${LANG_SIMPCHINESE} "正在向 Windows 注册 IfaceForge…"
    LangString IfgRegisterCli ${LANG_SIMPCHINESE} "正在安装同版本 ifg 命令并更新 PATH…"
    LangString IfgConfigureShortcuts ${LANG_SIMPCHINESE} "正在应用快捷方式选项…"
    LangString IfgShortcutWritten ${LANG_SIMPCHINESE} "已写入快捷方式"
    LangString IfgShortcutRemoved ${LANG_SIMPCHINESE} "已删除快捷方式"
    LangString IfgShortcutFailed ${LANG_SIMPCHINESE} "无法更新快捷方式"
    LangString IfgInstallComplete ${LANG_SIMPCHINESE} "程序文件和安装设置已就绪。"

    Section "-Describe installation"
      ${IfNot} ${Silent}
        SetDetailsPrint both
        DetailPrint "$(IfgInstallTarget) $INSTDIR"
        ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
        ${If} $0 != ""
          DetailPrint "$(IfgInstallUpgrade)"
        ${EndIf}
        DetailPrint "$(IfgInstallFiles)"
      ${EndIf}
    SectionEnd

    # The packager stages archive contents in 7z-out before copying them into the chosen folder.
    Function IfgReportInstalledFiles
      Exch $0
      Push $1
      Push $2
      FindFirst $1 $2 "$PLUGINSDIR\7z-out\$0*"
      ${IfNot} ${Errors}
        ${While} $2 != ""
          ${If} $2 != "."
          ${AndIf} $2 != ".."
            ${If} ${FileExists} "$PLUGINSDIR\7z-out\$0$2\*"
              Push "$0$2\"
              Call IfgReportInstalledFiles
            ${ElseIf} ${FileExists} "$INSTDIR\$0$2"
              DetailPrint "$(IfgFileInstalled) $0$2"
            ${Else}
              DetailPrint "$(IfgFileMissing) $0$2"
            ${EndIf}
          ${EndIf}
          FindNext $1 $2
        ${EndWhile}
        FindClose $1
      ${EndIf}
      ClearErrors
      Pop $2
      Pop $1
      Pop $0
    FunctionEnd

    Function IfgShortcutPage
      !insertmacro MUI_HEADER_TEXT "$(IfgShortcutTitle)" "$(IfgShortcutSubtitle)"
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == "error"
        Abort
      ${EndIf}

      ${NSD_CreateCheckbox} 0 4u 100% 16u "$(IfgStartMenuLabel)"
      Pop $IfgStartMenuField
      ${NSD_SetState} $IfgStartMenuField $IfgStartMenu
      ${NSD_OnClick} $IfgStartMenuField IfgRememberShortcuts

      ${NSD_CreateCheckbox} 0 26u 100% 16u "$(IfgDesktopLabel)"
      Pop $IfgDesktopField
      ${NSD_SetState} $IfgDesktopField $IfgDesktop
      ${NSD_OnClick} $IfgDesktopField IfgRememberShortcuts

      nsDialogs::Show
    FunctionEnd

    Function IfgRememberShortcuts
      Pop $0
      ${NSD_GetState} $IfgStartMenuField $IfgStartMenu
      ${NSD_GetState} $IfgDesktopField $IfgDesktop
    FunctionEnd
  !endif
!macroend
