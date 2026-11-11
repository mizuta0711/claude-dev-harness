# installer

{{APP_NAME}} のインストーラー（Inno Setup）の元。

## 必要なもの

- Windows PowerShell 5.1 以降（`pwsh` でも可）
- .NET {{DOTNET_MAJOR}} SDK
- Inno Setup 6.3 以降（`ISCC.exe`。`Program Files (x86)\Inno Setup 6` などから自動で探す）
- 公開するときだけ: GitHub CLI（`gh`。`gh auth login` 済み）

## 作り方

```console
powershell -File tools\build-installer.ps1                 # ランタイムあり・なしの 2 種
powershell -File tools\build-installer.ps1 -Variant Bundled
powershell -File tools\build-installer.ps1 -Variant Framework
```

- 版番号の元は `{{UI_CSPROJ}}` の `<Version>` の 1 か所
- スクリプトは `dist\` にインストーラーを作る。`web\downloads.json` があれば、実物から大きさと SHA-256 を計算してそれも更新する
- `tools\check-web.mjs` があれば、`node tools/check-web.mjs --dist dist` で版・大きさ・SHA-256 の食い違いを検査する

## 出力

| ファイル | 内容 |
|---|---|
| `dist\{{APP_NAME}}-{版}-win-x64-setup.exe` | ランタイムあり（.NET を同梱） |
| `dist\{{APP_NAME}}-{版}-win-x64-noruntime-setup.exe` | ランタイムなし（.NET {{DOTNET_MAJOR}} デスクトップ ランタイムが別に要る） |

`dist\` と `publish\` はリポジトリに入れない（`.gitignore`）。GitHub の Release へ上げる `tools\publish-release.ps1` は、利用者の指示があるときだけ実行する。リポジトリ名は `git remote get-url origin` から読む。

## 変えてはいけないもの

- **`{{APP_NAME}}.iss` の `AppIdGuid` を変えない。** 変えると上書き更新にならず、別のアプリとして二重に入る
- **インストーラーのファイル名の規則を変えない。** 配布サイト（`web\downloads.json`）と同じ規則で結ばれている
- アプリの起動中の印 `{{MUTEX_NAME}}`（`App.xaml.cs` の `RunningMutexName` と `.iss` の `RunningMutex`）は両方を同じに保つ

## 検証

ランタイムなし版の案内を出す（.NET を探す場所を存在しない場所へ差し替える）:

```console
powershell -File tools\build-installer.ps1 -Variant Framework -DotNetProbe "C:\no-such-dir\{{DOTNET_MAJOR}}.*"
```

終わったら、通常のビルドで `dist\` を作り直す（名前が同じため）。

<!-- >>> AUTORUN -->
## アンインストールで実行する PowerShell

`installer\remove-autorun-task.ps1` は、アンインストール時に自動実行のタスク「{{AUTORUN_TASK_NAME}}」を外す。直接は実行しない。

- `tools\build-installer.ps1` が、行全体のコメントと空行を落として UTF-16LE の Base64 にし、`/DRemoveAutoRunTaskCommand=...` で `.iss` へ渡す（日本語のタスク名をコマンド行で文字化けさせずに渡すため）。元はこのファイルの 1 か所だけ
- アンインストーラーは作業フォルダをインストール先にして実行する。タスクがインストール先の中の exe を指すときだけ外し、別の場所（開発中のビルドなど）を指す登録は残す。失敗しても終了コード 0 で終わる
- `ISCC.exe` を手で実行すると、この値が無いためコンパイルが止まる。`build-installer.ps1` から作る
<!-- <<< AUTORUN -->

## アンインストールで残るもの

設定と履歴のデータ（{{DATA_DIR_DESC}}）は消さない。残ることと消し方はマニュアルに書く。
