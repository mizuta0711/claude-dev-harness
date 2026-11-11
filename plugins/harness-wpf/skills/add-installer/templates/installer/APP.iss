; {{APP_NAME}} インストーラー スクリプト (Inno Setup 6.3 以降)
;
; ■ 版番号
;   {{UI_CSPROJ}} の <Version> が元（1 か所）。
;   tools\build-installer.ps1 が /DAppVersion=x.y.z を渡すため、通常はここを直接編集しない。
;
; ■ 作り方
;   通常は tools\build-installer.ps1 から作る（ランタイムあり・なしの 2 種を作り、必要な値を /D で渡す）。
;   自動実行の解除（下の AUTORUN の部分）を組み込んでいるときは、手でのコンパイルは止まる（build-installer.ps1 から作る）。
;   手でコンパイルする場合（ランタイムあり版）:
;     ISCC.exe /DAppVersion=1.0.0 installer\{{APP_NAME}}.iss
;   ランタイムなし版（.NET {{DOTNET_MAJOR}} デスクトップ ランタイムが別に要る）:
;     ISCC.exe /DAppVersion=1.0.0 /DFrameworkDependent=1 /DOutputSuffix=-noruntime /DPublishApp=..\publish\framework\app installer\{{APP_NAME}}.iss
;
; ■ ランタイムなし版の案内の検証
;   ランタイムを探す場所を、存在しない場所へ差し替えて作る:
;     tools\build-installer.ps1 -Variant Framework -DotNetProbe "C:\no-such-dir\{{DOTNET_MAJOR}}.*"
;   既定は {commonpf64}\dotnet\shared\Microsoft.WindowsDesktop.App\{{DOTNET_MAJOR}}.*

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
; 発行物のフォルダは build-installer.ps1 から /D で上書きできる
#ifndef PublishApp
  #define PublishApp "..\publish\bundled\app"
#endif
; ランタイムなし版は /DOutputSuffix=-noruntime を渡す
#ifndef OutputSuffix
  #define OutputSuffix ""
#endif
; アプリが使う .NET の主版（csproj の TargetFramework と合わせる）
#define DotNetMajor "{{DOTNET_MAJOR}}"
; ランタイムなし版がデスクトップ ランタイムを探す場所（検証用に差し替えられる）
#ifndef DotNetProbe
  #define DotNetProbe "{commonpf64}\dotnet\shared\Microsoft.WindowsDesktop.App\" + DotNetMajor + ".*"
#endif

#define AppName        "{{APP_NAME}}"
#define AppPublisher   "{{PUBLISHER}}"
#define AppURL         "{{SITE_URL}}"
#define AppExeName     "{{EXE_NAME}}.exe"
; アプリが起動中の間ずっと持っている印の名前（App.xaml.cs の RunningMutexName と同じにする）
#define RunningMutex   "{{MUTEX_NAME}}"
; AppId の GUID（波かっこなし）。アプリごとに新しく作り、一度配ったら変えない
#define AppIdGuid      "{{APP_ID_GUID}}"

[Setup]
; AppId は変更しないこと（同一アプリとして認識されて上書き更新になる。変えると別のアプリとして二重に入る）
; 先頭の "{{" は Inno Setup で "{" 1 文字を表す書き方
AppId={{{#AppIdGuid}}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppURL}
AppSupportURL={#AppURL}
AppUpdatesURL={#AppURL}
; ユーザーインストール（管理者権限不要）― %LocalAppData%\Programs\{{APP_NAME}}
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
OutputDir=..\dist
; ファイル名の規則は配布サイト（web\downloads.json）と共有の約束。変えない
OutputBaseFilename={#AppName}-{#AppVersion}-win-x64{#OutputSuffix}-setup
Compression=lzma2/ultra64
SolidCompression=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
; x64 および ARM64 の x64 エミュレーション環境が対象
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
UninstallDisplayIcon={app}\{#AppExeName}
UninstallDisplayName={#AppName}
VersionInfoVersion={#AppVersion}.0
VersionInfoCompany={#AppPublisher}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoDescription={#AppName} Setup
; 起動中の上書き・アンインストールは、アプリを強制終了せず、利用者に閉じてもらう（実行中の処理を途中で切らないため）。
; 起動中かどうかは固定名の mutex で見る。Restart Manager による「使用中のアプリを閉じる」と再起動は使わない
AppMutex={#RunningMutex}
CloseApplications=no
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "japanese"; MessagesFile: "compiler:Languages\Japanese.isl"

[CustomMessages]
; >>> HELP（同梱のマニュアル Help\manual\getting-started.html があるときだけ残す）
english.OpenGettingStarted=Open the getting started guide (in Japanese)
japanese.OpenGettingStarted=使い方（はじめに）を開く
; <<< HELP
english.DotNetMissing=The .NET {#DotNetMajor} Desktop Runtime was not found.%nThis installer needs .NET {#DotNetMajor} ({#DotNetMajor}.x). A newer .NET alone does not run this app.%n%nOpen the download page now?%n(Yes: open the page and exit. Install .NET, then run this setup again.%n No: continue anyway. Cancel: exit.)
japanese.DotNetMissing=.NET {#DotNetMajor} デスクトップ ランタイムが見つかりません。%nこのアプリには .NET {#DotNetMajor}（{#DotNetMajor}.x）が必要です。より新しい版の .NET だけでは動きません。%n%n今すぐダウンロードページを開きますか？%n（はい: ページを開いて終了します。.NET を入れたあと、このセットアップをもう一度実行してください。%n いいえ: そのまま続けます。キャンセル: 終了します。）

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; アプリの発行物一式（アプリ内ヘルプ用の Help\ があれば、csproj で出力に写してあるのでここに含まれる）
; デバッグ用の .pdb と、空のフォルダを残すための .gitkeep は配らない
Source: "{#PublishApp}\*"; DestDir: "{app}"; Excludes: "*.pdb,.gitkeep"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\{#AppName}\{#AppName}"; Filename: "{app}\{#AppExeName}"
Name: "{userprograms}\{#AppName}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#AppName}"; Filename: "{app}\{#AppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExeName}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
; >>> HELP（完了画面の「使い方（はじめに）を開く」。既定でチェックが付く。同梱の HTML を既定のブラウザで開く）
Filename: "{app}\Help\manual\getting-started.html"; Description: "{cm:OpenGettingStarted}"; Flags: shellexec postinstall skipifsilent
; <<< HELP

; >>> AUTORUN（アプリが自動実行をタスク スケジューラに登録するときだけ残す）
; アンインストール時、タスク「{{AUTORUN_TASK_NAME}}」を、このインストール先の exe を指すときだけ外す。失敗してもアンインストールは続く。
; 実行する PowerShell の元は installer\remove-autorun-task.ps1。build-installer.ps1 が UTF-16LE の Base64 にして
; /DRemoveAutoRunTaskCommand=... で渡す（日本語のタスク名をコマンド行でそのまま渡すと文字化けするため）。
#ifndef RemoveAutoRunTaskCommand
  #error RemoveAutoRunTaskCommand がありません。tools\build-installer.ps1 から作ってください（installer\remove-autorun-task.ps1 を Base64 にして渡します）
#endif
[UninstallRun]
; 作業フォルダ（WorkingDir = {app}）が、スクリプトの比べる「インストール先」になる
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -EncodedCommand {#RemoveAutoRunTaskCommand}"; WorkingDir: "{app}"; Flags: runhidden; RunOnceId: "RemoveAutoRunTask"
; <<< AUTORUN

; 設定と履歴のデータ（{{DATA_DIR_DESC}}）はアンインストールで消さない。
; [UninstallDelete] にデータの置き場を書かないこと（残ることと消し方はマニュアルに書く）

#ifdef FrameworkDependent
[Code]
function FindDotNetDesktopRuntime: Boolean;
var
  FindRec: TFindRec;
begin
  Result := FindFirst(ExpandConstant('{#DotNetProbe}'), FindRec);
  if Result then FindClose(FindRec);
end;

function InitializeSetup: Boolean;
var
  Res: Integer;
  ErrorCode: Integer;
begin
  Result := True;
  if not FindDotNetDesktopRuntime then begin
    Res := MsgBox(ExpandConstant('{cm:DotNetMissing}'), mbConfirmation, MB_YESNOCANCEL);
    if Res = IDYES then begin
      ShellExec('open', 'https://dotnet.microsoft.com/download/dotnet/{#DotNetMajor}.0', '', '', SW_SHOW, ewNoWait, ErrorCode);
      Result := False;
    end else if Res = IDCANCEL then begin
      Result := False;
    end;
    // IDNO: そのまま続行（別の場所に入れてある場合など）
  end;
end;
#endif
