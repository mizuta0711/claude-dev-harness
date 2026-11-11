#Requires -Version 5.1
<#
.SYNOPSIS
    {{APP_NAME}} のインストーラー 2 種を GitHub の Release へ上げます。

.DESCRIPTION
    ★ 外へ出す操作です。利用者の指示があるときだけ実行すること（AI が自分の判断で実行しない）。

    手順:
      1. リポジトリ名を git remote get-url origin から読む（GitHub のものだけ）
      2. 未コミットの変更が無いことを確かめる
      3. gh CLI の確認
      4. tools\build-installer.ps1 で dist\ に 2 種を作る（-SkipBuild で省略可）。web\downloads.json があればそれも更新される
      5. tools\check-web.mjs があれば、dist\ の実物と web\downloads.json（版・大きさ・SHA-256）を照合する
      6. ビルドで変わったファイル（downloads.json など）があれば止める（未コミットのまま上げない）
      7. タグ v{版} を作って push する（-SkipTag で省略可）
      8. gh release create で dist\ の 2 ファイルを上げる

    事前準備:
      winget install --id GitHub.cli
      gh auth login

.PARAMETER Version
    版番号（例: 1.1.0）。省略時は {{UI_CSPROJ}} の <Version>。
    csproj の <Version> を先に直してから実行すること（このスクリプトは csproj を書き換えない）。

.PARAMETER NotesFile
    リリースノート（1 行 1 項目。先頭の "- " は任意。空行と "#" 始まりの行は無視）。省略時は自動生成の文面。
    web\downloads.json の notes（更新履歴ページの文）は、このスクリプトでは書かない。手で書くこと。

.PARAMETER SkipBuild
    ビルドを省略する（dist\ に作成済みのものがあるとき）。

.PARAMETER SkipTag
    タグの作成と push を省略する。

.PARAMETER Draft
    ドラフトのリリースとして作る（GitHub 上で公開前に確認できる）。

.EXAMPLE
    .\tools\publish-release.ps1 -NotesFile docs\release-notes\v1.0.0.md
    .\tools\publish-release.ps1 -Draft
#>
param(
    [string]$Version   = "",
    [string]$NotesFile = "",
    [switch]$SkipBuild,
    [switch]$SkipTag,
    [switch]$Draft
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$appName = "{{APP_NAME}}"
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    # ── リポジトリ名（定数で持たない。origin から読む） ────────────────────
    # 手で書くと実物と食い違う（実際に食い違ったことがある）。origin が正。
    # 標準エラーは 2> でリダイレクトしない（PowerShell 5.1 の Stop のもとでは例外になる。下の gh と同じ理由）
    $originUrl = (git remote get-url origin)
    if ($LASTEXITCODE -ne 0 -or -not $originUrl) { throw "git remote の origin がありません。GitHub のリポジトリを origin に設定してください。" }
    $originUrl = ([string]$originUrl).Trim()
    if ($originUrl -notmatch 'github\.com[:/](?<owner>[^/]+)/(?<name>[^/]+?)(\.git)?/?$') {
        throw "origin が GitHub のリポジトリではありません: $originUrl"
    }
    $repo = "$($Matches['owner'])/$($Matches['name'])"

    # ── 版 ─────────────────────────────────────────────────────────────────
    if (-not $Version) {
        [xml]$csproj = Get-Content "{{UI_CSPROJ}}" -Encoding UTF8
        $node = @($csproj.Project.PropertyGroup) |
            Where-Object { $null -ne $_.PSObject.Properties['Version'] -and $_.Version -ne "" } |
            Select-Object -First 1
        if (-not $node) { throw "csproj に <Version> がありません。" }
        $Version = $node.Version.Trim()
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "版番号の形が不正です: $Version（例: 1.2.3）" }
    $tag = "v$Version"
    Write-Host "リリース: $Version  タグ: $tag  リポジトリ: $repo" -ForegroundColor Cyan

    $fileBundled   = Join-Path $projectRoot "dist\$appName-${Version}-win-x64-setup.exe"
    $fileNoRuntime = Join-Path $projectRoot "dist\$appName-${Version}-win-x64-noruntime-setup.exe"

    # ── リリースノート（ビルドに時間がかかるので先に読む） ────────────────
    $noteLines = @()
    if ($NotesFile) {
        $notesPath = if ([System.IO.Path]::IsPathRooted($NotesFile)) { $NotesFile } else { Join-Path $projectRoot $NotesFile }
        if (-not (Test-Path $notesPath)) { throw "リリースノートが見つかりません: $notesPath" }
        $noteLines = @(
            [System.IO.File]::ReadAllLines($notesPath, (New-Object System.Text.UTF8Encoding($false))) |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ -ne "" -and $_ -notmatch '^#' } |
            ForEach-Object { $_ -replace '^[-*]\s*', '' }
        )
        if ($noteLines.Count -eq 0) { throw "リリースノートが空です: $notesPath" }
    } else {
        Write-Warning "-NotesFile が無いため、リリースの本文は GitHub の自動生成になります。"
    }

    # ── 未コミットの変更（追跡済みのもの）が無いこと ──────────────────────
    $dirty = @(git status --porcelain | Where-Object { $_ -notmatch '^\?\?' -and $_ -ne '' })
    if ($dirty.Count -gt 0) {
        git status --short
        throw "コミットされていない変更があります。コミットしてから再実行してください。"
    }

    # ── gh CLI ─────────────────────────────────────────────────────────────
    if (-not (Get-Command "gh" -ErrorAction SilentlyContinue)) {
        throw "gh CLI が見つかりません。winget install --id GitHub.cli のあと gh auth login を実行してください。"
    }
    # Windows PowerShell 5.1 では、$ErrorActionPreference = "Stop" のもとで
    # 外部コマンドの標準エラーを 2>&1 で受けると例外になる。cmd 経由で終了コードだけを見る
    cmd /c "gh auth status >nul 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "gh CLI が未認証です。gh auth login を実行してください。" }

    # ── ビルド ─────────────────────────────────────────────────────────────
    if (-not $SkipBuild) {
        & "$PSScriptRoot\build-installer.ps1" -Version $Version -Variant Both
    } else {
        Write-Host "(-SkipBuild: ビルドを省略)"
    }
    foreach ($f in @($fileBundled, $fileNoRuntime)) {
        if (-not (Test-Path $f)) { throw "インストーラーが見つかりません: $f（-SkipBuild を外してください）" }
    }

    # ── 公開前の検査（版・ファイル名・大きさ・SHA-256 と dist\ の照合）──────
    # -SkipBuild のときも必ず走らせる（古い dist\ を上げないため）
    $checkWeb = Join-Path $PSScriptRoot "check-web.mjs"
    if (Test-Path $checkWeb) {
        node $checkWeb --dist (Join-Path $projectRoot "dist")
        if ($LASTEXITCODE -ne 0) { throw "check-web.mjs が失敗しました。指摘を直してから再実行してください。" }
    } else {
        Write-Warning "tools\check-web.mjs が無いため、dist\ と web\downloads.json の照合は飛ばします（配布サイトを置いていないプロジェクト）。"
    }

    # ビルドが downloads.json を書き換えたら、未コミットのまま上げない
    $dirtyAfter = @(git status --porcelain | Where-Object { $_ -notmatch '^\?\?' -and $_ -ne '' })
    if ($dirtyAfter.Count -gt 0) {
        git status --short
        throw "ビルドで変わったファイルがあります（downloads.json など）。コミットしてから -SkipBuild を付けて再実行してください。"
    }

    # ── タグ ───────────────────────────────────────────────────────────────
    if (-not $SkipTag) {
        if ((git tag -l $tag) -eq $tag) { throw "タグ $tag は既にあります。（-SkipTag で省略できます）" }
        git tag -a $tag -m "Release $tag"
        if ($LASTEXITCODE -ne 0) { throw "git tag が失敗しました。" }
        git push origin $tag
        if ($LASTEXITCODE -ne 0) { throw "タグの push が失敗しました。" }
    } else {
        Write-Host "(-SkipTag: タグを省略)"
    }

    # ── Release ────────────────────────────────────────────────────────────
    $ghArgs = [System.Collections.Generic.List[string]]::new()
    foreach ($a in @("release", "create", $tag, $fileBundled, $fileNoRuntime, "--repo", $repo, "--title", "$appName $tag")) { $ghArgs.Add($a) }
    if ($noteLines.Count -gt 0) {
        $ghArgs.Add("--notes"); $ghArgs.Add((($noteLines | ForEach-Object { "- $_" }) -join "`n"))
    } else {
        $ghArgs.Add("--generate-notes")
    }
    if ($Draft) { $ghArgs.Add("--draft") }
    & gh @ghArgs
    if ($LASTEXITCODE -ne 0) { throw "gh release create が失敗しました（exit $LASTEXITCODE）" }

    Write-Host ""
    Write-Host "リリース完了: https://github.com/$repo/releases/tag/$tag" -ForegroundColor Green
    if (Test-Path (Join-Path $projectRoot "web\downloads.json")) {
        Write-Host "次: 配布サイトのダウンロード置き場へ dist\ の 2 ファイルを置き、web\ を公開する（web\deploy\ があればその手順に従う）。" -ForegroundColor Yellow
    }
} finally {
    Pop-Location
}
