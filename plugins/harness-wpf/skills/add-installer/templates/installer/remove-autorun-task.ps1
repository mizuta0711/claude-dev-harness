# アンインストール時に実行する: 自動実行のタスク「{{AUTORUN_TASK_NAME}}」を、インストール先の exe を指すときだけ外す。
#
# ・直接は実行しない。tools\build-installer.ps1 が UTF-16LE の Base64 にして .iss へ渡し、
#   アンインストーラーが powershell.exe -EncodedCommand で、作業フォルダ = インストール先 で実行する
# ・別の場所の exe（開発中のビルドなど）を指す登録は残す
# ・比べるパスの末尾に \ を足す（C:\...\Programs\App が C:\...\Programs\App2 に前方一致しないように）
# ・失敗してもアンインストールを止めない（必ず終了コード 0）
$ErrorActionPreference='Stop'
try {
  $app=[Environment]::CurrentDirectory.TrimEnd('\')+'\'
  $t=Get-ScheduledTask -TaskPath '\' -TaskName '{{AUTORUN_TASK_NAME}}'
  foreach($a in $t.Actions){
    $e=[Environment]::ExpandEnvironmentVariables([string]$a.Execute).Trim('"')
    if($e.StartsWith($app,[StringComparison]::OrdinalIgnoreCase)){ Unregister-ScheduledTask -InputObject $t -Confirm:$false; break }
  }
} catch {}
exit 0
