---
name: capture-screenshots
description: 実機・エミュレータのスクリーンショットを adb で撮影する。端末の選択・画面操作・撮影・プライバシー保護チェックまでの一連の手順を実行する。「スクショを撮って」「画面キャプチャして」「動作確認して」等と依頼されたら使う。
allowed-tools: "Bash, PowerShell, Read, Glob"
---

# 実機・エミュレータのスクリーンショット撮影

`adb`（Android SDK Platform Tools）だけを使う。MCP も追加ツールも要らない。

> ⚠️ **この手順は端末を接続した状態で1本通してから信用すること。**
> 端末の機種・OS 版・画面サイズで挙動が変わるため、**初回は各コマンドの結果を目視で確認する**。

## Step 1. 端末を確かめる

```bash
adb devices
```

| 結果 | 対応 |
|------|------|
| 1台だけ `device` と出る | そのまま進む |
| **複数出る** | **以降のすべての adb コマンドに `-s <シリアル>` を付ける**（付けないと `more than one device` で失敗する） |
| `unauthorized` | 端末側の「USB デバッグを許可しますか」を承認してもらう |
| 何も出ない | **ここで止めてユーザーに伝える。** 端末が無い状態で先へ進まない |

## Step 2. アプリを目的の画面にする

```bash
adb shell am start -n <applicationId>/.MainActivity     # 起動
adb shell input tap <x> <y>                             # タップ
adb shell input text "..."                              # 文字入力（日本語は入らない）
adb shell input keyevent KEYCODE_BACK                   # 戻る
```

**座標を当て推量で叩かない。** 画面の要素と座標は次で確認する:

```bash
adb shell uiautomator dump /sdcard/window_dump.xml
adb pull /sdcard/window_dump.xml
```

`bounds="[left,top][right,bottom]"` の中心をタップ座標にする。
**Compose の画面は要素が `uiautomator` に出ないことがある**（`Modifier.semantics` が無い場合）。
出ない場合は撮影した画像を見ながら座標を決め、**そのことを報告に書く**。

## Step 3. 撮影する

**端末側に保存してから引き取る**（シェルに依存しないため、これを既定とする）:

```bash
# 保存先が無ければ先に作る（PowerShell は New-Item -ItemType Directory -Force screenshots）
mkdir -p screenshots

adb shell screencap -p /sdcard/screen.png
adb pull /sdcard/screen.png screenshots/<画面名>_<yyyymmdd>.png
adb shell rm /sdcard/screen.png
```

> ⚠️ **リポジトリのルート直下に `./screenshot.png` のような名前で落とさない。**
> 撮り直すたびに上書きされ、消し忘れがルートに散る。**保存先はプロジェクトが決めた
> ディレクトリ配下に固定する**（既定は `screenshots/`。`docs/` や `assets/` 配下に
> 決めているプロジェクトはそちらへ）。**`adb pull` は保存先が無いと失敗する。**

> **コミットするかはプロジェクトで決める。** マニュアルに載せる画像は追跡し、
> 動作確認用の撮り捨ては `.gitignore` に入れる。**どちらにするか決めずに撮ると、
> 下のプライバシー保護チェックを通していない画像が履歴に入る。**

> ⚠️ **`adb exec-out screencap -p > out.png` を PowerShell で使わない。**
> PowerShell のリダイレクトはバイト列をテキストとして扱うため、**PNG が壊れる**。
> Git Bash / WSL では使えるが、**手順を1つに揃える方が事故が少ない**。

## Step 4. 撮れたものを必ず自分で見る

**Read ツールで画像を開いて確認する。** ファイルが出来たことは成功を意味しない
（真っ黒・前の画面・ダイアログが閉じる前、はいずれも実際に起きる）。

## ★プライバシー保護チェック（撮影のたびに必須・省略禁止）

Android の画面には**実利用者のデータがそのまま写る**。公開・共有する画像では特に注意する。

1. **通知シェード・ステータスバーの通知**を写さない（他アプリの通知内容が出る）
2. **実在の個人情報**（連絡先の氏名・電話番号・メールアドレス・住所・写真・トーク本文）を写さない。
   デモ用のダミーデータへ差し替えてから撮る
3. **アカウント名・端末名・位置情報**が画面に出ていないか確認する
4. Read ツールで**目視確認し、上記が写っていないことを確認してから採用する**

差し替えられない場合は、**その画面は撮らない**（黒塗りは残骸が残ることがある）。

## 補足

- 保存先は `screenshots/`（既定）や `docs/`・`assets/` 配下など、プロジェクトで決めた場所に統一する。
  **ルート直下に置かない**
- **アプリをアンインストールしない。** 再インストールは上書き（`adb install -r` /
  `./gradlew installDebug`）で行う。アンインストールすると
  DataStore・SharedPreferences・Room のデータが全て消える
  - `harness-android` のフックは `adb uninstall` / `pm uninstall` / `pm clear` /
    `gradlew uninstall*` を **deny する**（**承認すれば通るのではない**）。
    必要な場合は**ユーザーに確認を取り、ユーザー自身に実行してもらう**
- 画面の録画が要る場合は `adb shell screenrecord /sdcard/demo.mp4`
  （Ctrl+C で停止 → `adb pull /sdcard/demo.mp4 screenshots/`）

## 結果報告

撮影したファイル一覧・使った端末（シリアル / エミュレータ名）・
プライバシー保護チェックを実施した旨を報告すること。
**座標を画像から推定して操作した場合は、その旨も書く。**
