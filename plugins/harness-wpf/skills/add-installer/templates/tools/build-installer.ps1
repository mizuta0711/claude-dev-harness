#Requires -Version 5.1
<#
.SYNOPSIS
    {{APP_NAME}} のインストーラー（Windows x64）を作ります。配布サイトの版の一覧（web\downloads.json）があれば、それも更新します。

.DESCRIPTION
    1. dotnet publish（{{UI_CSPROJ}} だけ）
    2. 言語フォルダが英語・日本語以外に残っていたら警告して取り除く
    3. Inno Setup でインストーラーを作る → dist\
    4. web\downloads.json があれば、dist\ の実物から大きさと SHA-256 を計算して更新する（無ければ飛ばす）

    既定では「ランタイムあり版」「ランタイムなし版」の両方を作ります。
    Inno Setup 6.3 以降が必要です（https://jrsoftware.org/isinfo.php）。
    版番号の元は {{UI_CSPROJ}} の <Version> の 1 か所です。

.PARAMETER Version
    版番号を上書きする場合に指定します（例: 1.1.0）。省略時は csproj の <Version>。

.PARAMETER Variant
    Both（既定）: ランタイムあり版 + ランタイムなし版
    Bundled     : ランタイムあり版のみ（.NET ランタイム同梱）
    Framework   : ランタイムなし版のみ（.NET デスクトップ ランタイムが別に要る）

.PARAMETER DotNetProbe
    ランタイムなし版が .NET を探す場所を差し替えます（案内の検証用。例: C:\no-such-dir\{{DOTNET_MAJOR}}.*）。
    dist\ へ出る名前は通常のものと同じになるため、検証が済んだら必ず通常のビルドで作り直してください。
    （このときは downloads.json を更新しません）

.EXAMPLE
    .\tools\build-installer.ps1
    .\tools\build-installer.ps1 -Variant Bundled
    .\tools\build-installer.ps1 -Version 1.1.0
#>
param(
    [string]$Version = "",
    [ValidateSet("Both", "Bundled", "Framework")]
    [string]$Variant = "Both",
    [string]$DotNetProbe = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$appName = "{{APP_NAME}}"
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    $csprojPath = "{{UI_CSPROJ}}"
    $issPath    = "installer\$appName.iss"

    # ── 版の解決 ───────────────────────────────────────────────────────────
    if (-not $Version) {
        [xml]$csproj = Get-Content $csprojPath -Encoding UTF8
        $versionNode = @($csproj.Project.PropertyGroup) |
            Where-Object { $null -ne $_.PSObject.Properties['Version'] -and $_.Version -ne "" } |
            Select-Object -First 1
        if (-not $versionNode) { throw "$csprojPath に <Version> がありません。" }
        $Version = $versionNode.Version.Trim()
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "版番号の形が不正です: $Version（例: 1.2.3）" }
    $fourPartVer = $Version + ".0"
    Write-Host "版: $Version  バリアント: $Variant" -ForegroundColor Cyan

    $publishBundled   = Join-Path $projectRoot "publish\bundled"
    $publishFramework = Join-Path $projectRoot "publish\framework"
    $distDir          = Join-Path $projectRoot "dist"

    foreach ($dir in @($publishBundled, $publishFramework)) {
        if (Test-Path $dir) { Write-Host "クリーン: $dir"; Remove-Item $dir -Recurse -Force }
    }
    New-Item -ItemType Directory -Force $distDir | Out-Null

    # ── Inno Setup（ISCC.exe）を探す ───────────────────────────────────────
    $isccCandidates = [System.Collections.Generic.List[string]]::new()
    $isccCmd = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
    if ($isccCmd) { $isccCandidates.Add($isccCmd.Source) }
    $isccCandidates.Add("${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe")
    $isccCandidates.Add("${env:ProgramFiles}\Inno Setup 6\ISCC.exe")
    $isccCandidates.Add("${env:LOCALAPPDATA}\Programs\Inno Setup 6\ISCC.exe")
    $iscc = $isccCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $iscc) {
        throw "Inno Setup 6.3 以降が見つかりません。https://jrsoftware.org/isinfo.php から入れてください。"
    }
    Write-Host "Inno Setup: $iscc"

    # ── アンインストールで自動実行のタスクを外すスクリプト（あれば） ──────
    # installer\remove-autorun-task.ps1 を UTF-16LE の Base64 にして .iss へ渡す（-EncodedCommand 用）。
    # 元を 1 か所にし、読める形と渡す形が食い違わないようにするため、毎回ここで作る。
    # 行全体のコメントと空行は落とす（コマンド行を短くするため）。
    $commonDefines = @()
    $autoRunScript = Join-Path $projectRoot "installer\remove-autorun-task.ps1"
    if (Test-Path $autoRunScript) {
        $scriptText = [System.IO.File]::ReadAllText($autoRunScript, (New-Object System.Text.UTF8Encoding($false)))
        $scriptText = $scriptText.TrimStart([char]0xFEFF)
        $body = @($scriptText -split "`r?`n" | Where-Object { $_.Trim() -ne "" -and $_ -notmatch '^\s*#' }) -join "`n"
        $encoded = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($body))
        $commonDefines += "/DRemoveAutoRunTaskCommand=$encoded"
        Write-Host "アンインストール時のタスク解除: installer\remove-autorun-task.ps1 を組み込みます"
    } else {
        Write-Host "アンインストール時のタスク解除: installer\remove-autorun-task.ps1 が無いため組み込みません（自動実行を登録しないアプリ）"
    }

    # 同梱のマニュアルがリポジトリにあるなら、発行物にも入っていることを確かめる
    $manualInRepo = Test-Path (Join-Path $projectRoot "web\manual\getting-started.html")
    if (-not $manualInRepo) {
        Write-Host "同梱のマニュアルの確認: web\manual\getting-started.html が無いため飛ばします"
    }

    # ── 発行 ───────────────────────────────────────────────────────────────
    $langPattern = '^[A-Za-z]{2}(-[A-Za-z]{2,4})?$'

    function Invoke-PublishVariant {
        param([string]$VariantLabel, [string]$PublishRoot, [string]$SelfContained)
        Write-Host ""
        Write-Host "■ $VariantLabel / $csprojPath" -ForegroundColor Yellow
        $outDir = Join-Path $PublishRoot "app"
        dotnet publish $csprojPath `
            -c Release `
            -r win-x64 `
            "--self-contained" $SelfContained `
            -o $outDir `
            "/p:Version=$Version" `
            "/p:FileVersion=$fourPartVer" `
            "/p:AssemblyVersion=$fourPartVer"
        if ($LASTEXITCODE -ne 0) { throw "dotnet publish が失敗しました（exit $LASTEXITCODE）" }

        # 言語フォルダ（2 文字の言語、または xx-XX 形式）が、英語・日本語以外に残っていたら警告して取り除く。
        # csproj の SatelliteResourceLanguages で出ないはずだが、効かない部品があったときの保険
        $keep = @("en", "ja", "ja-JP")
        $allLang = @(Get-ChildItem $outDir -Directory | Where-Object { $_.Name -match $langPattern })
        $extra = @($allLang | Where-Object { $keep -notcontains $_.Name })
        if ($extra.Count -gt 0) {
            Write-Warning ("英語・日本語以外の言語フォルダが発行物に残っていたため取り除きます: " + (($extra | ForEach-Object { $_.Name }) -join ", "))
            foreach ($d in $extra) { Remove-Item $d.FullName -Recurse -Force }
        } else {
            $names = ($allLang | ForEach-Object { $_.Name }) -join ", "
            Write-Host "言語フォルダ: 英語・日本語以外は残っていません（残っているもの: $names）" -ForegroundColor Green
        }
        if ($manualInRepo -and -not (Test-Path (Join-Path $outDir "Help\manual\getting-started.html"))) {
            throw "発行物に Help\manual\getting-started.html がありません（web\manual が同梱されていません。csproj の Content の設定を確かめてください）。"
        }
    }

    function Invoke-InnoSetup {
        param([string]$PublishBase, [string]$OutputSuffix, [string]$VariantLabel, [string[]]$ExtraDefines = @())
        Write-Host ""
        Write-Host "インストーラーを作っています ($VariantLabel)..." -ForegroundColor Cyan
        $isccArgs = [System.Collections.Generic.List[string]]::new()
        $isccArgs.Add("/Q")
        $isccArgs.Add("/DAppVersion=$Version")
        $isccArgs.Add("/DPublishApp=$(Join-Path $PublishBase 'app')")
        $isccArgs.Add("/DOutputSuffix=$OutputSuffix")
        foreach ($d in $commonDefines) { $isccArgs.Add($d) }
        foreach ($d in $ExtraDefines) { $isccArgs.Add($d) }
        $isccArgs.Add($issPath)
        & $iscc @isccArgs
        if ($LASTEXITCODE -ne 0) { throw "Inno Setup のコンパイルが失敗しました（$VariantLabel, exit $LASTEXITCODE）" }
        $outputFile = Join-Path $distDir "$appName-${Version}-win-x64${OutputSuffix}-setup.exe"
        if (-not (Test-Path $outputFile)) { throw "出力ファイルが見つかりません: $outputFile" }
        $sizeMB = [math]::Round((Get-Item $outputFile).Length / 1MB, 1)
        Write-Host "完了: $outputFile ($sizeMB MB)" -ForegroundColor Green
    }

    $built = [ordered]@{}   # 種類 -> dist のファイル名

    if ($Variant -eq "Both" -or $Variant -eq "Bundled") {
        Write-Host ""; Write-Host "=== ランタイムあり版（self-contained） ===" -ForegroundColor Magenta
        Invoke-PublishVariant -VariantLabel "Bundled" -PublishRoot $publishBundled -SelfContained "true"
        Invoke-InnoSetup -PublishBase $publishBundled -OutputSuffix "" -VariantLabel "ランタイムあり版"
        $built["bundled"] = "$appName-${Version}-win-x64-setup.exe"
    }

    if ($Variant -eq "Both" -or $Variant -eq "Framework") {
        Write-Host ""; Write-Host "=== ランタイムなし版（framework-dependent） ===" -ForegroundColor Magenta
        Invoke-PublishVariant -VariantLabel "Framework" -PublishRoot $publishFramework -SelfContained "false"
        $defines = @("/DFrameworkDependent=1")
        if ($DotNetProbe) { $defines += "/DDotNetProbe=$DotNetProbe" }
        Invoke-InnoSetup -PublishBase $publishFramework -OutputSuffix "-noruntime" -VariantLabel "ランタイムなし版" -ExtraDefines $defines
        $built["noruntime"] = "$appName-${Version}-win-x64-noruntime-setup.exe"
    }

    if ($DotNetProbe) {
        Write-Warning "-DotNetProbe を指定したため、web\downloads.json は更新しません。検証が済んだら通常のビルドで作り直してください。"
        return
    }

    # ── web\downloads.json の更新（あれば） ────────────────────────────────
    # 同じ版: date と files だけ置き換え、notes は保つ。新しい版: 先頭に足して latest を変える。
    # JSON は UTF-8（BOM なし）・2 スペース字下げ・LF。
    $jsonPath = Join-Path $projectRoot "web\downloads.json"
    if (-not (Test-Path $jsonPath)) {
        Write-Host ""
        Write-Host "web\downloads.json が無いため、版の一覧の更新は飛ばします（配布サイトを置いていないプロジェクト）。"
        Write-Host ""
        Write-Host "作成完了 → dist\" -ForegroundColor Green
        return
    }

    function ConvertTo-JsonString([string]$s) {
        $sb = New-Object System.Text.StringBuilder
        [void]$sb.Append('"')
        foreach ($ch in $s.ToCharArray()) {
            $code = [int]$ch
            if     ($ch -eq [char]'"')  { [void]$sb.Append('\"') }
            elseif ($ch -eq [char]'\')  { [void]$sb.Append('\\') }
            elseif ($code -eq 10)       { [void]$sb.Append('\n') }
            elseif ($code -eq 13)       { [void]$sb.Append('\r') }
            elseif ($code -eq 9)        { [void]$sb.Append('\t') }
            elseif ($code -lt 32)       { [void]$sb.Append(('\u{0:x4}' -f $code)) }
            else                        { [void]$sb.Append($ch) }
        }
        [void]$sb.Append('"')
        return $sb.ToString()
    }

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    $existing = @()
    $parsed = [System.IO.File]::ReadAllText($jsonPath, $utf8NoBom) | ConvertFrom-Json
    if ($null -ne $parsed.PSObject.Properties['versions']) { $existing = @($parsed.versions) }

    # 実物（dist\）から計算した、今回作った種類の files
    $newFiles = @{}
    foreach ($kind in $built.Keys) {
        $path = Join-Path $distDir $built[$kind]
        $newFiles[$kind] = [pscustomobject]@{
            kind   = $kind
            name   = $built[$kind]
            size   = [int64](Get-Item $path).Length
            sha256 = (Get-FileHash $path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }

    $kindOrder = @("bundled", "noruntime")
    $today = Get-Date -Format "yyyy-MM-dd"
    $found = $false
    $entries = @()
    foreach ($v in $existing) {
        if ($v.version -eq $Version) {
            $found = $true
            # 今回作らなかった種類の行は、前のまま残す
            $files = @{}
            foreach ($f in @($v.files)) { $files[[string]$f.kind] = $f }
            foreach ($k in $newFiles.Keys) { $files[$k] = $newFiles[$k] }
            $v.date = $today
            $v.files = @($kindOrder | Where-Object { $files.ContainsKey($_) } | ForEach-Object { $files[$_] })
        }
        $entries += $v
    }
    if (-not $found) {
        Write-Warning "版 $Version は downloads.json に無かったため、先頭に足しました。notes（更新履歴の文）を書いてください。"
        $files = @($kindOrder | Where-Object { $newFiles.ContainsKey($_) } | ForEach-Object { $newFiles[$_] })
        $entries = @([pscustomobject]@{ version = $Version; date = $today; notes = @(); files = $files }) + $entries
    }

    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('{')
    $lines.Add('  "latest": ' + (ConvertTo-JsonString $Version) + ',')
    $lines.Add('  "versions": [')
    for ($i = 0; $i -lt $entries.Count; $i++) {
        $e = $entries[$i]
        $notes = (@($e.notes | ForEach-Object { ConvertTo-JsonString ([string]$_) })) -join ', '
        $lines.Add('    {')
        $lines.Add('      "version": ' + (ConvertTo-JsonString ([string]$e.version)) + ',')
        $lines.Add('      "date": ' + (ConvertTo-JsonString ([string]$e.date)) + ',')
        $lines.Add('      "notes": [' + $notes + '],')
        $lines.Add('      "files": [')
        $fs = @($e.files)
        for ($j = 0; $j -lt $fs.Count; $j++) {
            $f = $fs[$j]
            $comma = ''
            if ($j -lt $fs.Count - 1) { $comma = ',' }
            $lines.Add('        { "kind": ' + (ConvertTo-JsonString ([string]$f.kind)) + ', "name": ' + (ConvertTo-JsonString ([string]$f.name)) +
                ', "size": ' + ([int64]$f.size) + ', "sha256": ' + (ConvertTo-JsonString ([string]$f.sha256)) + ' }' + $comma)
        }
        $lines.Add('      ]')
        if ($i -lt $entries.Count - 1) { $lines.Add('    },') } else { $lines.Add('    }') }
    }
    $lines.Add('  ]')
    $lines.Add('}')
    [System.IO.File]::WriteAllText($jsonPath, (($lines -join "`n") + "`n"), $utf8NoBom)
    Write-Host "更新: web\downloads.json（latest = $Version）" -ForegroundColor Green

    Write-Host ""
    Write-Host "作成完了 → dist\" -ForegroundColor Green
    if (Test-Path (Join-Path $PSScriptRoot "check-web.mjs")) {
        Write-Host "次: node tools/check-web.mjs --dist dist で、版・大きさ・SHA-256 の食い違いを検査してください。"
    }
} finally {
    Pop-Location
}
