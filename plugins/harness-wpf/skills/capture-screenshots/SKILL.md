---
name: capture-screenshots
description: マニュアル・READMEなどに使う実機スクリーンショットを撮影する。WPFソフトウェアレンダリング切替・UIAutomation操作・プライバシー保護チェックまでの一連の手順を実行する。「スクショを撮って」「画面キャプチャして」等と依頼されたら使う。
allowed-tools: "PowerShell, Read, Glob"
---

# 実機スクリーンショット撮影

再利用ライブラリ `${CLAUDE_PLUGIN_ROOT}/tools/ui-capture.ps1` を dot-source して使う。

```powershell
. "${CLAUDE_PLUGIN_ROOT}/tools/ui-capture.ps1"
```

> このライブラリは **harness-wpf プラグインに同梱**されている（プロジェクト側の `tools/` ではない）。
> `${CLAUDE_PLUGIN_ROOT}` はプラグインの配置先へ展開される。

## 手順

1. **ソフトウェアレンダリングへ切替**（必須）：WPFはハードウェアレンダリングのままだとGDIキャプチャが「タイトルバーだけで中身が真っ白」になる。`Set-WpfSoftwareRender`（`HKCU\…\Avalon.Graphics\DisableHWAcceleration=1`）を実行する。
2. **対象アプリを起動**：スクショにデモデータを写したい場合は、あらかじめ用意したサンプルデータを引数に起動する。
3. **画面操作**：UIAutomationのヘルパー（`Invoke-MenuItem` / `Invoke-Button` / `Toggle-Button`）を使う。自前描画コントロール（AutomationPeerが無くUIAに出ない要素）はウィンドウ実枠＋座標で叩く（`Invoke-ClickPoint` / `Click-RelativePoint`。オフセット値は対象コントロールのレイアウトに合わせて実測して渡す）。ファイル選択は `Invoke-Button '…' 'ファイルを開く'` → `Load-OpenFileDialog @(paths)`（最下部EditへWM_SETTEXT＋開くボタンBM_CLICK）。
4. **撮影**：`Capture-AppWindow '<タイトル一部>' out.png`（AttachThreadInputで前面化＋DWM実枠をCopyFromScreen）。
5. **ソフトウェアレンダリングを元に戻す**（必須）：`Restore-WpfHwAccel` を必ず実行する。

## ★プライバシー保護チェック（撮影のたびに必須・省略禁止）

1. **ファイルを開く/保存ダイアログ（エクスプローラ）は絶対に撮影しない**（ダイアログを閉じてからアプリ本体だけ撮る）。
2. **アプリ画面内に個人フォルダパスを写さない**——デモ用データ（ログ・プロジェクト等）は `C:\Users\<名前>\…`（`C:\Users\Public` も含む）ではなく**中立パス（例 `D:\Demo\`）に置く**。パス欄などアプリが表示する文字列にも個人フォルダ名が出てしまうため。
3. 撮影結果はReadツールで**目視確認し、ユーザー名・個人フォルダ・その他個人情報が写っていないことを確認してから**採用する。

## 補足

- 撮影用PowerShellドライバを一時ファイルで作る場合、Windows PowerShell 5.1はBOM無しUTF-8をCP932と誤読して日本語が化けるため、実行前に**UTF-8 BOM付き**へ再エンコードする（`[System.IO.File]::WriteAllText($p,$t,(New-Object System.Text.UTF8Encoding($true)))`）。
  同じ理由で、同梱の `ui-capture.ps1` 自体も UTF-8 BOM 付きで配布している。
- スクショの格納先は `docs/` や `assets/` 等プロジェクトで決めた場所に統一する。

## 結果報告

撮影したファイル一覧と、プライバシー保護チェックを実施した旨を報告すること。
