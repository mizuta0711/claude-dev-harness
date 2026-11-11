---
name: add-installer
description: WPF（.NET）アプリに Inno Setup のインストーラー一式を組み込む。ランタイムあり／なしの 2 種・日本語と英語だけ・管理者権限なし・起動中は上書きさせない、の形で、installer/<アプリ名>.iss・tools/build-installer.ps1・tools/publish-release.ps1・installer/README.md を置き、csproj に版と言語の設定を、App.xaml.cs に起動中の印（名前付き mutex）を足す。「インストーラーを作りたい」「配布できる形にしたい」「setup.exe を作って」「Inno Setup で固めて」「リリース用のビルドを用意して」と頼まれたら使う。配布サイト（add-distribution-site）・アプリ内ヘルプ（add-help-window）と組み合わせられるが、単独でも使える。
allowed-tools: "PowerShell, Bash, Read, Edit, Write, Glob, Grep"
---

# インストーラーを組み込む（Inno Setup）

WPF アプリを、利用者に渡せるインストーラー（`setup.exe`）にする仕組みを、雛形から組み込む。
組み込んだあとは `tools\build-installer.ps1` を 1 回実行すれば、`dist\` に 2 種のインストーラーができる。

雛形は `${CLAUDE_PLUGIN_ROOT}/skills/add-installer/templates/` にある。

## 何を作るか

| 置くもの | 中身 |
|---|---|
| `installer/<アプリ名>.iss` | Inno Setup のスクリプト。ランタイムあり／なしを 1 本で作り分ける。言語は日本語と英語だけ |
| `installer/README.md` | 作り方・出力・変えてはいけないもの・検証の方法（プロジェクトの開発者向け） |
| `installer/remove-autorun-task.ps1` | **任意。** アンインストール時に、自動実行のタスクを外す。アプリが自動実行を登録するときだけ置く |
| `tools/build-installer.ps1` | 発行 → 余分な言語フォルダの除去 → インストーラー 2 種 →（あれば）`web/downloads.json` の更新 |
| `tools/publish-release.ps1` | GitHub の Release へ上げる。**利用者の指示があるときだけ実行する** |

あわせて、プロジェクトの次のファイルを直す。

- **csproj**: `Version`・`AssemblyVersion`・`FileVersion`・`SatelliteResourceLanguages` を足す
- **App.xaml.cs**: 起動中の印（名前付き mutex）を、アプリが動いている間ずっと持つようにする
- **.gitignore**: `dist/` と `publish/` を足す

## 前提

- **Inno Setup 6.3 以降**（`ISCC.exe`。https://jrsoftware.org/isinfo.php ）。英語（`Default.isl`）と日本語（`Languages\Japanese.isl`）が入っていること
- **.NET SDK**（アプリの `TargetFramework` の版）
- **gh CLI**（公開するときだけ。`gh auth login` 済み）
- Windows PowerShell 5.1 以降

### 3 つのスキルの関係

| スキル | 作るもの |
|---|---|
| `add-distribution-site` | `web/` の配布サイト・`web/downloads.json`・`tools/check-web.mjs` |
| `add-help-window` | WebView2 のヘルプ窓と、`web/manual/**`・`web/assets/**` を出力の `Help\` へ写す csproj の設定 |
| **`add-installer`（これ）** | インストーラー一式・版の設定・起動中の印 |

推奨の順は **add-distribution-site → add-help-window → add-installer**。ただし、このスキルは**単独でも使える**。
無いものに合わせて、次のように振る舞う。

| 無いもの | このスキルの振る舞い |
|---|---|
| `web/downloads.json` | `build-installer.ps1` は版の一覧の更新を飛ばし、その旨を表示する |
| `tools/check-web.mjs` | `publish-release.ps1` は公開前の照合を飛ばし、警告を出す |
| `Help\` への同梱（add-help-window 未適用） | `.iss` の完了画面から「使い方（はじめに）を開く」を外す（手順 3 の `HELP` を `$false`） |
| 自動実行の登録（アプリが登録しない） | `remove-autorun-task.ps1` を置かず、`.iss` と README の自動実行の部分を外す（手順 3 の `AUTORUN` を `$false`） |

### 3 つのスキルで共有する約束

ここを変えると、ほかの 2 つと食い違う。**変えない。**

- **インストーラーのファイル名**: `{{APP_NAME}}-<版>-win-x64-setup.exe`（ランタイムあり）／`{{APP_NAME}}-<版>-win-x64-noruntime-setup.exe`（ランタイムなし）。`<版>` は `x.y.z`
- **`web/downloads.json` の形**（`build-installer.ps1` が書き、配布サイトが読む）:

  ```json
  {
    "latest": "1.0.0",
    "versions": [
      {
        "version": "1.0.0",
        "date": "2026-01-01",
        "notes": ["最初の版"],
        "files": [
          { "kind": "bundled", "name": "<APP_NAME>-1.0.0-win-x64-setup.exe", "size": 71234567, "sha256": "<小文字の16進>" },
          { "kind": "noruntime", "name": "<APP_NAME>-1.0.0-win-x64-noruntime-setup.exe", "size": 3456789, "sha256": "<小文字の16進>" }
        ]
      }
    ]
  }
  ```

  同じ版で作り直したときは、その版の `date` と `files` だけを置き換え、`notes` は保つ。新しい版なら先頭に足し、`latest` を変える。UTF-8（BOM なし）・2 スペース字下げ・LF。
- **`tools/check-web.mjs --dist <dir>`**: `<dir>` にある最新版のインストーラー 2 つの大きさと SHA-256 が `downloads.json` と合うかを見て、合わなければ 0 以外で終わる
- **同梱のマニュアルの入口**: 出力の `Help\manual\getting-started.html`（元は `web/manual/getting-started.html`）
- **版番号の元**: csproj の `<Version>` の 1 か所

## 差し替える値の一覧

雛形の `{{名前}}` を、次の値に置き換える。**値を決めたら、利用者に一覧で見せて確かめてから写す。**

| プレースホルダ | 中身 | 決め方・例 |
|---|---|---|
| `{{APP_NAME}}` | アプリの名前。インストーラーのファイル名・インストール先のフォルダ名・スタートメニューの名前になる | 英数字・`-`・`.` だけ（空白なし）。例 `MyTool` |
| `{{EXE_NAME}}` | exe のファイル名（**拡張子なし**） | csproj の `<AssemblyName>`。無ければ csproj のファイル名。例 `MyTool.UI` |
| `{{UI_CSPROJ}}` | 発行する csproj の、リポジトリのルートからのパス（区切りは `\` でも `/` でもよく、他の 2 本と同じ csproj を指していればよい） | 例 `MyTool.UI\MyTool.UI.csproj` |
| `{{PUBLISHER}}` | 発行者 | csproj の `<Company>`。無ければ利用者に聞く |
| `{{SITE_URL}}` | 配布サイトのトップ（末尾は `/`） | 配布サイトが無ければ GitHub のリポジトリの URL |
| `{{APP_ID_GUID}}` | Inno Setup の `AppId`（**波かっこなし**） | **アプリごとに新しく作る**: `[guid]::NewGuid().ToString().ToUpper()`。別アプリと同じにすると、上書き・アンインストールが混ざる |
| `{{MUTEX_NAME}}` | 起動中の印の名前 | 既定は `{{APP_NAME}}.Running`。ほかのアプリと重ならない名前 |
| `{{DOTNET_MAJOR}}` | アプリが使う .NET の主版 | csproj の `TargetFramework` から。`net8.0-windows` なら `8` |
| `{{DATA_DIR_DESC}}` | 設定や履歴のデータの置き場の説明（コメントと README に出る） | アプリのコードで確かめる。例 `%LOCALAPPDATA%\MyTool` |
| `{{AUTORUN_TASK_NAME}}` | **任意。** アプリがタスク スケジューラに登録する自動実行のタスク名 | アプリのコードで確かめる。登録しないなら空 |

3 つのスキルで共通の名前のうち、`{{UI_PROJECT_DIR}}`（App.xaml.cs のあるフォルダ）と `{{ROOT_NAMESPACE}}` は雛形には出てこない。手順 4 で App.xaml.cs を探すときに使う。

## 手順

### 1. 値を確かめる

- csproj（`{{UI_CSPROJ}}`）・App.xaml.cs・`.gitignore` を読む
- 次を見て、上の表の値と分岐を決める
  - `web/downloads.json`・`tools/check-web.mjs` があるか（あればそのまま使われる）
  - csproj に `Help\manual` へ写す設定があり、`web/manual/getting-started.html` があるか → **HELP**
  - アプリのコードがタスク スケジューラに登録しているか（`Register-ScheduledTask`・`schtasks`・`TaskService` などを grep）→ **AUTORUN**
  - アプリのデータの置き場（`%LOCALAPPDATA%` の下か）。**インストール先（exe の隣）に保存していたら、先に利用者に伝える**（上書き・アンインストールでデータが消える）
  - アプリが `RollForward` を指定しているか（「守ること」の 5）
- `installer/`・`tools/build-installer.ps1`・`tools/publish-release.ps1` が既にあれば、**上書きしない**。差分を利用者に見せて判断を仰ぐ

### 2. 値の一覧を利用者に見せる

表の値と、HELP・AUTORUN の判定を見せて、確かめてもらう。`{{APP_ID_GUID}}` はここで作る。

### 3. 雛形を写して置き換える

プロジェクトのルートで、次を実行する（値と分岐を書き換えてから）。文字コードは `.ps1` と `.iss` を **UTF-8 BOM 付き**、`README.md` を BOM なし、改行はどれも LF にする。

```powershell
$tpl = "${CLAUDE_PLUGIN_ROOT}/skills/add-installer/templates"
$values = [ordered]@{
    '{{APP_NAME}}'          = 'MyTool'
    '{{EXE_NAME}}'          = 'MyTool.UI'
    '{{UI_CSPROJ}}'         = 'MyTool.UI\MyTool.UI.csproj'
    '{{PUBLISHER}}'         = 'Your Name'
    '{{SITE_URL}}'          = 'https://example.com/'
    '{{APP_ID_GUID}}'       = '00000000-0000-0000-0000-000000000000'   # 手順 2 で作った値
    '{{MUTEX_NAME}}'        = 'MyTool.Running'
    '{{DOTNET_MAJOR}}'      = '8'
    '{{DATA_DIR_DESC}}'     = '%LOCALAPPDATA%\MyTool'
    '{{AUTORUN_TASK_NAME}}' = ''                                       # 自動実行を登録しないなら空
}
$keep = @{ HELP = $true; AUTORUN = ($values['{{AUTORUN_TASK_NAME}}'] -ne '') }

$app = $values['{{APP_NAME}}']
$files = @(
    @{ src = 'installer/APP.iss';           dst = "installer/$app.iss";          bom = $true  },
    @{ src = 'installer/README.md';         dst = 'installer/README.md';         bom = $false },
    @{ src = 'tools/build-installer.ps1';   dst = 'tools/build-installer.ps1';   bom = $true  },
    @{ src = 'tools/publish-release.ps1';   dst = 'tools/publish-release.ps1';   bom = $true  }
)
if ($keep.AUTORUN) {
    $files += @{ src = 'installer/remove-autorun-task.ps1'; dst = 'installer/remove-autorun-task.ps1'; bom = $true }
}

foreach ($f in $files) {
    $dst = Join-Path (Get-Location) $f.dst
    if (Test-Path $dst) { throw "既にあります: $($f.dst)（上書きしない。差分を見て判断する）" }
    $text = [System.IO.File]::ReadAllText((Join-Path $tpl $f.src), (New-Object System.Text.UTF8Encoding($false))).TrimStart([char]0xFEFF)
    foreach ($k in $values.Keys) { $text = $text.Replace($k, $values[$k]) }
    # >>> 名前 ～ <<< 名前 の囲みを、残すなら印の行だけ消し、残さないなら中身ごと消す
    $out = New-Object System.Collections.Generic.List[string]
    $skip = $false
    foreach ($line in ($text -replace "`r`n", "`n") -split "`n") {
        if ($line -match '>>> (HELP|AUTORUN)') { $skip = -not $keep[$Matches[1]]; continue }
        if ($line -match '<<< (HELP|AUTORUN)') { $skip = $false; continue }
        if (-not $skip) { $out.Add($line) }
    }
    New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
    [System.IO.File]::WriteAllText($dst, ($out -join "`n"), (New-Object System.Text.UTF8Encoding($f.bom)))
    Write-Host "写した: $($f.dst)"
}
```

### 4. csproj と App.xaml.cs に組み込む

**csproj**（`{{UI_CSPROJ}}`）の `PropertyGroup` に足す。既に `Version` があれば、その値を使う（書き換えない）。

```xml
<!-- 版番号の元はここだけ（インストーラー名・配布サイトの版表示は tools/build-installer.ps1 がここから作る） -->
<Version>1.0.0</Version>
<AssemblyVersion>1.0.0.0</AssemblyVersion>
<FileVersion>1.0.0.0</FileVersion>
<!-- 依存パッケージが同梱する多言語のリソースのうち、英語・日本語だけを出力へ含める -->
<SatelliteResourceLanguages>en;ja;ja-JP</SatelliteResourceLanguages>
```

**App.xaml.cs**（`{{UI_PROJECT_DIR}}\App.xaml.cs`）に、起動中の印を足す。`OnStartup` が無ければ足す（`App.xaml` の `StartupUri` はそのままでよい）。

```csharp
/// <summary>アプリが起動中であることの印（固定名）。インストーラー（Inno Setup の AppMutex）が、起動中の上書き・アンインストールを止めるために見る。</summary>
private const string RunningMutexName = "{{MUTEX_NAME}}";

private Mutex? _runningMarker;

protected override void OnStartup(StartupEventArgs e)
{
    base.OnStartup(e);

    // 起動中の印を、アプリが生きている間ずっと持つ。2 つ目の起動でも作るだけで、所有権の有無は問わない
    // （名前のある印が在ることだけが意味を持つ）。作れなくてもアプリの動作は止めない
    try { _runningMarker = new Mutex(false, RunningMutexName); }
    catch (Exception)
    {
        // 記録の仕組み（ログ）があるなら、例外を受けて残す（インストーラーが起動中を検知できなくなるため）
    }

    // …既存の起動処理…
}

protected override void OnExit(ExitEventArgs e)
{
    _runningMarker?.Dispose();
    base.OnExit(e);
}
```

- **二重起動を防ぐ mutex とは別に持つ。** 二重起動の印はデータの置き場ごとだったり、待ちを伴ったりして、「起動している間ずっとある」とは限らない。既に**固定名で、起動中ずっと持っている** mutex があるなら、それを `{{MUTEX_NAME}}` にしてもよい
- 名前は `.iss` の `RunningMutex` と**同じ文字列**にする（置き換えで同じ値が入る）

**.gitignore** に `dist/` と `publish/` が無ければ足す。

### 5. 置き換え残しが無いことを確かめる

```powershell
Select-String -Path installer\*, tools\build-installer.ps1, tools\publish-release.ps1 -Pattern '\{\{[A-Z][A-Z0-9_]*\}\}'
```

何も出なければよい。`.iss` の `AppId={{{#AppIdGuid}}` は Inno Setup の書き方（`{{` が `{` 1 文字）なので、この検索には掛からない。**`{{` だけで探さない。**

### 6. ビルドする

```powershell
powershell -NoProfile -File tools\build-installer.ps1
```

- `dist\` に 2 つできること、言語フォルダの行に英語・日本語以外が無いことを見る
- `tools/check-web.mjs` があれば `node tools/check-web.mjs --dist dist` も走らせる
- ランタイムなし版の案内の検証には `-Variant Framework -DotNetProbe "C:\no-such-dir\{{DOTNET_MAJOR}}.*"` で作る。**検証のあとは通常のビルドで作り直す**（同じ名前で出るため）

### 7. 実機で確かめる

下の「受け入れ基準」を、利用者と一緒に実機で確かめる。インストール・アンインストールは利用者の PC の状態を変えるので、**実行の前に何をするかを伝える**。

## 守ること（なぜ込み）

1. **言語を日本語と英語に絞る。** csproj に `SatelliteResourceLanguages` が無いと、依存パッケージの言語リソースが十数か国語分入る。`build-installer.ps1` は効かない部品があったときの保険として、残った言語フォルダを警告して消す。Inno Setup の言語も日本語と英語だけにする。
2. **起動中の上書き・アンインストールは止めるだけで、アプリを殺さない。** アプリが名前付き mutex を持ち続け、`.iss` は `AppMutex` でそれを見る。`CloseApplications=no`・`RestartApplications=no` にする。Restart Manager の「使用中のアプリを閉じる」は、アプリにはログオフと同じに見え、実行中の処理（コピーや削除）を途中で切る。
3. **管理者権限なしで入れる。** `PrivilegesRequired=lowest`、入れる先は `{localappdata}\Programs\{{APP_NAME}}`。UAC を出さず、利用者ごとに入れる。
4. **自動実行の登録は、インストール先の exe を指すものだけ外す**（AUTORUN のときだけ）。開発中のビルドを指す登録まで消さないため。比べるパスの末尾に `\` を足す（`...\Programs\App` が `...\Programs\App2` に前方一致しないように）。PowerShell は `-EncodedCommand` で渡す（日本語のタスク名がコマンド行で化けるため）。`-ExecutionPolicy Bypass` は要らない（スクリプト ファイルではないため）。元のスクリプトは `installer/remove-autorun-task.ps1` の 1 か所で、`build-installer.ps1` が毎回 Base64 にする。
5. **ランタイムなし版は、決まった主版を探して案内する。** `Microsoft.WindowsDesktop.App\{{DOTNET_MAJOR}}.*` を探し、無ければ入手先を出す。`RollForward` を指定していないアプリは、新しい版の .NET だけでは動かない。だから「.NET {{DOTNET_MAJOR}} 以降」ではなく「.NET {{DOTNET_MAJOR}}（{{DOTNET_MAJOR}}.x）が必要」と書く。`RollForward` を指定しているアプリなら、案内の文と探す場所をそれに合わせて直す。
6. **設定と履歴のデータはアンインストールで消さない。** `[UninstallDelete]` にデータの置き場を書かない。残ることと消し方はマニュアルに書く（利用者が入れ直したときに設定が戻るように）。
7. **完了画面に「使い方（はじめに）を開く」を既定のチェックありで出す**（HELP のときだけ）。インストーラーからアプリのヘルプ窓は開けないので、同梱の HTML を `shellexec` で既定のブラウザで開く。
8. **`AppId` はアプリごとに新しく作り、一度配ったら変えない。** 変えると上書き更新にならず、別のアプリとして二重に入る。別アプリと同じ値にすると、片方の上書き・アンインストールがもう片方を壊す。
9. **版番号は csproj の `<Version>` の 1 か所。** インストーラー名・`downloads.json`・Release のタグはここから作る。手で書くと必ずずれる。
10. **公開の前に照合する**（`publish-release.ps1`）。タグを打つ前に `check-web.mjs --dist dist` で、インストーラーの大きさと SHA-256 が `downloads.json` と合うかを見る。`-SkipBuild` のときも必ず見る（古い `dist\` を上げないため）。ビルドが `downloads.json` を書き換えたら、未コミットのまま上げずに止める。
11. **`gh auth status` は `cmd /c "gh auth status >nul 2>&1"` で確かめる。** Windows PowerShell 5.1 では、`$ErrorActionPreference = "Stop"` のもとで外部コマンドの標準エラーを `2>&1` や `2>$null` で受けると例外になる。終了コードだけを見る。
12. **リポジトリ名は `git remote get-url origin` から読む。** 定数で持つと実物と食い違う（実際に食い違ったことがある）。
13. **`.ps1` は UTF-8 BOM 付きで置く。** Windows PowerShell 5.1 は BOM なしの UTF-8 を CP932 と誤読し、日本語が化ける。`.iss` も BOM 付きにする（Inno Setup 6 は BOM で UTF-8 と判断する）。

## 受け入れ基準（実機で確かめる項目）

`(HELP)`・`(AUTORUN)`・`(サイト)` の付いた項目は、その条件のときだけ確かめる。

- [ ] `build-installer.ps1` を 1 回実行すると、`{{APP_NAME}}-{版}-win-x64-setup.exe` と `{{APP_NAME}}-{版}-win-x64-noruntime-setup.exe` の 2 つが `dist\` にでき、版は csproj の `<Version>` と同じ（確認: スクリプトを実行してファイルを見る）
- [ ] (サイト) `node tools/check-web.mjs --dist dist` で、版・ファイル名・大きさ・SHA-256 の食い違いの指摘が出ない。**配布サイトの本文と写真がまだなら、雛形の印（`<!-- 雛形: -->`）と未撮影の画像も指摘になり、終了コードは 1 になる。** 公開の前に止めるための正しい動きなので、通すために印や画像の参照を消さない（本文を書き、写真を撮ってから通す）
- [ ] インストーラーの言語の選択肢は日本語と英語の 2 つだけ（確認: インストーラーを起動して目で見る）
- [ ] インストール先のフォルダに、英語と日本語以外の言語のリソースフォルダが無い（確認: フォルダの一覧）
- [ ] インストールで管理者権限を求めない（UAC が出ない）。入る先は `%LOCALAPPDATA%\Programs\{{APP_NAME}}`（確認: 実機）
- [ ] ランタイムなし版を、.NET {{DOTNET_MAJOR}} デスクトップ ランタイムが無いときに実行すると、ランタイムが要ることと入手先が案内される（確認: `-DotNetProbe` で探す場所を変えて作ったもので確かめる）
- [ ] (HELP) 完了画面に「使い方（はじめに）を開く」があり、既定でチェックが付いていて、完了すると、はじめに読むページが既定のブラウザで開く（確認: 実機）
- [ ] (HELP) 入れたアプリで F1 を押すと、ヘルプ窓にマニュアルが出る（確認: 実機。add-help-window の基準と同じ）
- [ ] アプリを起動したまま、上書きインストール・アンインストールをしようとすると、アプリを閉じるよう求められ、閉じるまで進まない。インストーラーがアプリを強制終了しない（確認: 実機。処理の実行中にも）
- [ ] 同じインストーラー、または新しい版で上書きしても、「インストールされているアプリ」の一覧に 1 つしか出ない（確認: 設定のアプリの一覧）
- [ ] アンインストールすると、インストール先のフォルダとスタートメニューの項目が消える（確認: 実機）
- [ ] (AUTORUN) アンインストールすると、タスク スケジューラの「{{AUTORUN_TASK_NAME}}」が消える（確認: 入れたアプリで自動実行を登録してからアンインストールし、タスク スケジューラを見る）
- [ ] (AUTORUN) 別の場所の exe（開発中のビルドなど）を指す「{{AUTORUN_TASK_NAME}}」は、アンインストールで消えない（確認: 開発中のビルドで登録してから、入れたものをアンインストールする。確かめたら元に戻す）
- [ ] アンインストールしても、設定と履歴のデータ（{{DATA_DIR_DESC}}）は残る（確認: 実機）

配布サイトのダウンロードページに書くこと（2 種の違い・動作環境・SmartScreen の警告・SHA-256）と、サーバでの公開の手順は、`add-distribution-site` の受け入れ基準で確かめる。

## やらないこと

- **公開しない。** `tools/publish-release.ps1` の実行・タグの作成と push・`gh release create` は外へ出す操作なので、**利用者がはっきり指示したときだけ**行う。組み込みの確かめのために走らせない
- **コード署名はしない。** 署名なしのインストーラーには SmartScreen の警告が出る。案内は配布サイト側（add-distribution-site）で書く
- **マニュアルの本文は書かない。** 書くのは harness-doc（`plan-doc` → `manual-writer`）
- **言語を足さない。** 日本語と英語以外が要るなら、利用者と決めてから `.iss` の `[Languages]`・`[CustomMessages]` と `SatelliteResourceLanguages` をそろえて直す
- **既にある `installer/`・`tools/` のファイルを黙って上書きしない**

## 結果報告

写したファイル・直したファイル（csproj・App.xaml.cs・.gitignore）・使った値の一覧（`{{APP_ID_GUID}}` を含む）・HELP と AUTORUN の判定・ビルドの結果（`dist\` のファイル名と大きさ）・実機で確かめた受け入れ基準と、まだ確かめていない項目を報告する。
