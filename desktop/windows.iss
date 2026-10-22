#ifndef StageDir
  #error StageDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif
#ifndef AppVersion
  #error AppVersion is required
#endif

[Setup]
AppId={{6AC3C1EF-E217-4C3F-B5BD-648891F2863F}
AppName=AsterCite
AppVersion={#AppVersion}
AppPublisher=AsterCite
AppPublisherURL=https://github.com/Wahuwahuuu/AsterCite
AppSupportURL=https://github.com/Wahuwahuuu/AsterCite/issues
DefaultDirName={localappdata}\Programs\AsterCite
DefaultGroupName=AsterCite
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=AsterCite-{#AppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
LicenseFile={#StageDir}\LICENSE
InfoBeforeFile={#StageDir}\desktop\install-notes.txt
UninstallDisplayName=AsterCite
CloseApplications=no
SetupLogging=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\AsterCite"; Filename: "{app}\Start-AsterCite.cmd"; WorkingDir: "{app}"
Name: "{group}\Uninstall AsterCite"; Filename: "{uninstallexe}"
Name: "{autodesktop}\AsterCite"; Filename: "{app}\Start-AsterCite.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\.runtime\vc_redist.x64.exe"; Parameters: "/install /passive /norestart"; StatusMsg: "Preparing the Microsoft Visual C++ runtime..."; Check: NeedsVCRuntime; Flags: waituntilterminated
Filename: "{app}\Start-AsterCite.cmd"; Description: "Start AsterCite"; Flags: nowait postinstall skipifsilent shellexec

[Code]
function NeedsVCRuntime: Boolean;
var
  Installed, Minor: Cardinal;
begin
  Result := not (RegQueryDWordValue(HKLM64,
    'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Installed', Installed) and (Installed = 1)
    and RegQueryDWordValue(HKLM64, 'SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64', 'Minor', Minor) and (Minor >= 40));
end;
