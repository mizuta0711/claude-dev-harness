---
name: unity-verify
description: Unity MCP を使って実装の動作確認を行う。シーン・GameObject の状態確認、Console のエラー/警告確認、必要に応じて Play モードでの実行時確認（例外検出・進行確認・画面キャプチャ）を実施し、機能設計書の動作確認計画と突き合わせて報告する。実装完了後に使う。
argument-hint: "[確認対象（シーン名・機能名など。省略時は直近の変更から判定）]"
allowed-tools: "Bash(git diff:*), Bash(until:*), Glob, Grep, Read, ReadMcpResourceTool, mcp__UnityMCP__*"
---

# Unity 動作確認（Unity MCP）

`harness.config.json` の `verification.skill` が `unity-verify` の環境で使う動作確認スキル。

> ## ⚠️ このスキルは体感確認を代替しない
>
> `harness.config.json` の `verification.manualGate` は **`true`** である。
> **面白さ・見た目・実プレイ感の確認は、ユーザーが Unity Editor で行う。**
> このスキルが確認できるのは「コンパイルが通るか」「シーン・GameObject の構成が意図どおりか」
> 「Console にエラー・警告が出ていないか」までであり、**それをもって「動作確認済み」としてはならない**。
>
> 報告の最後で必ず**ユーザーへ体感確認を依頼する**こと（Step 5）。

## Step 0: Unity MCP の疎通確認

`mcp__UnityMCP__*` ツールが利用可能かを確認する。

見つからない場合は **未接続**。以下をユーザーに確認してもらい、
**このスキルはここで終了する**（推測で先へ進まない）:

- Unity Editor が起動しているか
- `Window > MCP For Unity` で Local Server が起動しているか
- 接続できない場合の対処は `SETUP.md`「既知のトラブル」を参照

## Step 1: 確認対象の特定

$ARGUMENTS があればそれを対象とする。無ければ直近の変更から判定する:

```bash
git diff --name-only
```

変更がない場合は直近1コミット:

```bash
git diff --name-only HEAD~1
```

| 変更ファイル | 確認対象 |
|-------------|---------|
| `Assets/Scripts/**` | そのクラスがアタッチされている GameObject / Prefab |
| `Assets/Scenes/*.unity` | そのシーンの構成 |
| `Assets/Prefabs/**` | その Prefab と、それを使うシーン |

対応関係は `docs/設計書/コンポーネント一覧.md`（アタッチ先が記載されている）と
`docs/設計書/プレハブ一覧.md` を参照して特定する。

## Step 2: 確認計画の読み込み

作業中の機能設計書（`docs/features/` 直下）に**「動作確認計画」の章**があれば、
その確認項目を控える。

> 章番号ではなく**見出し名で探すこと**。設計書テンプレートの章構成は変わりうるため、
> 「§4」「§5」のような番号での参照はしない。

設計書が無い場合は Step 3・Step 4 の共通確認のみを行う。

## Step 3: シーン・GameObject の状態確認

Unity MCP のツールで構成を確認する:

| 確認すること | 使うツール |
|-------------|-----------|
| 現在開かれているシーン / シーンの構成 | `manage_scene` |
| 対象 GameObject の存在・階層・アタッチされたコンポーネント | `find_gameobjects` / `manage_gameobject` |
| インスペクタ上の参照が切れていないか（Missing Reference） | `manage_gameobject` |

確認結果は「設計書（`docs/設計書/`）に書かれた構成と一致しているか」で判定する。
**乖離があればそれ自体が指摘事項**であり、`/harness-core:update-docs` の対象になる。

## Step 4: Console のエラー・警告確認

スクリプトを変更・作成した直後は、**先に再コンパイルの完了を待つ**:

```json
mcp__UnityMCP__refresh_unity { "mode": "force", "scope": "all", "compile": "request", "wait_for_ready": true }
```

そのうえで `read_console` でコンパイルエラー・警告を確認する:

```json
mcp__UnityMCP__read_console { "action": "get", "types": ["error", "warning"], "count": 20, "format": "detailed" }
```

- **エラーが1件でもあれば「不合格」**。内容を報告し、修正してから再実行する
- 警告は件数と内容を報告する（既存の警告か、今回の変更で増えたのかを区別する）
- `types` に指定できるのは **`error` / `warning` / `log` / `all` のみ**。`"exception"` はエラーになる
  （実行時例外は `error` に含まれる）

## Step 4.5: Play モードでの確認（任意）

実行時例外の検出・ゲームが進行するかの確認が必要な場合のみ実施する。
**Step 4 で Console エラーが1件でもあれば Play モードに入らない**（先に修正する）。

> このステップでも**体感確認は代替できない**。分かるのは「例外が出ないか」「進行するか」
> 「特定時点の数値状態」「静止画としての画面」までであり、面白さ・操作感・難易度バランスは
> 依然としてユーザーが Unity Editor で確認する。

### 前提条件: `Application.runInBackground`

**これが `false` だと、Editor が非アクティブな間ゲームが進まない。**
MCP で操作している間 Editor は常に非アクティブなので、**この設定なしでは Play モード確認は成立しない**
（実測: Play 開始後に待機しても `Time.time=0.06` のまま停止していた）。

Play に入る前にプロジェクト設定へ永続化する（初回のみ。Play モード外で実行すること）:

```json
mcp__UnityMCP__execute_code { "action": "execute",
  "code": "UnityEditor.PlayerSettings.runInBackground = true; return \"ok\";" }
```

### 手順

**1. シーンを保存する。** Play 中のシーン変更は停止時に破棄されるため、必ず先に保存する。

```json
mcp__UnityMCP__manage_scene { "action": "save" }
```

**2. Play を開始する。**

```json
mcp__UnityMCP__manage_editor { "action": "play" }
```

`{"success":true,"message":"Entered play mode."}` が返る（既に Play 中なら `"Already in play mode."`）。
`play` / `stop` は冪等なので、状態が不明でもそのまま撃ってよい。

> **`success` は「Play に入り終えた」ことを意味しない。**
> 実装は `EditorApplication.isPlaying = true` を代入して即座に返るだけなので、次の状態確認が要る。
>
> なお **`pause` はトグル**（`isPaused = !isPaused`）であり冪等ではない。
> 状態を確認せずに撃たないこと。Play 中でなければエラーになる。

**3. Play に入りきるまで待つ。** Editor の状態は MCP リソースで取得する。

```
ReadMcpResourceTool { "server": "UnityMCP", "uri": "mcpforunity://editor/state" }
```

| フィールド | 判定 |
|-----------|------|
| `editor.play_mode.is_playing` | `true` になるまで待つ |
| `editor.play_mode.is_changing` | `true` の間は遷移中。`false` になるまで待つ |
| `activity.phase` | `idle` 以外（`compiling` / `domain_reload` / `playmode_transition` 等）の間は待つ |

**このリソースが読めない場合は `execute_code` で代替する**（判定内容は同じ）:

```json
mcp__UnityMCP__execute_code { "action": "execute",
  "code": "return \"isPlaying=\" + UnityEditor.EditorApplication.isPlaying + \" isChanging=\" + UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode;" }
```

**4. 画面を確認する。**

```json
mcp__UnityMCP__manage_camera { "action": "screenshot",
  "include_image": true, "max_resolution": 900, "capture_source": "game_view" }
```

- **`include_image: true` を必ず付ける。** 付ければ画像が応答に含まれる（`Screenshot captured to ...`）。
  省略すると遅延書き出しになり（`Screenshot requested to ...`）、返った `data.path` を `Read` する一手間が増える
- **`width` / `height` というパラメータは存在しない**（指定するとエラー）。解像度は `max_resolution` で指定する
- `capture_source` は `game_view`（既定）/ `scene_view`。`view_position` / `view_target` で任意視点からも撮れる
- 出力先は `Assets/Screenshots/`。**プロジェクトの `.gitignore` に追加されているか確認する**（検証用の一時ファイルのため）

**5. 時間経過が必要な場合は待機する。**

```bash
until [ $SECONDS -ge 30 ]; do sleep 3; done; echo waited
```

> PowerShell の `Start-Sleep` は**ハーネスにブロックされる**。上記の Bash の until ループを使うこと。

**6. 実行時の状態を確認する。** 本当に進行しているかは `Time.time` / `Time.frameCount` の増加で判定する。

```json
mcp__UnityMCP__execute_code { "action": "execute",
  "code": "return \"isPlaying=\" + Application.isPlaying + \" Time.time=\" + Time.time + \" frame=\" + Time.frameCount;" }
```

機能設計書の「動作確認計画」に数値で判定できる項目があれば、
`UnityEngine.Object.FindFirstObjectByType<T>()` で対象を取得して同様に読み出す。

**7. Console を再確認する。** Play 中は `read_console` をそのまま呼べる。実行時例外・NullReference はここで出る。

**8. Play を停止する。**

```json
mcp__UnityMCP__manage_editor { "action": "stop" }
```

`"Exited play mode."` が返る（Play 中でなければ `"Already stopped (not in play mode)."`）。
**確認が終わったら必ず停止する。** Play モードのまま放置すると以降のスクリプト編集・アセット操作ができない。

## Step 5: 報告

以下のフォーマットで報告する:

```markdown
### Unity 動作確認 結果

| 項目 | 結果 |
|------|------|
| Unity MCP 接続 | ✅ 接続済み / ❌ 未接続（未接続ならここで終了） |
| 確認対象 | {シーン名 / GameObject / Prefab} |
| シーン・GameObject 構成 | ✅ 設計書と一致 / ⚠️ 乖離あり（内容） |
| Console エラー | ✅ 0件 / ❌ N件（内容） |
| Console 警告 | N件（内容・既存かどうか） |
| Play モード確認 | ⚪ 未実施 / ✅ 実行時例外なし・進行を確認（`Time.time` / `frame`） / ❌ 例外あり（内容） |
| 動作確認計画の項目 | ✅ N/N 確認済み / ⚠️ 一部未確認（理由） |

#### 確認できたこと
- ...

#### 確認できていないこと（重要）
- **面白さ・操作感・難易度バランス** — MCP では確認できない
- **見た目の良し悪し** — 静止画は撮れるが、判断はユーザーが行う

#### ユーザーへの依頼
Unity Editor で Play モードを実行し、以下を体感で確認してください:
- {動作確認計画の「重点観点」から転記した項目}
```

**「動作確認計画」の項目のうち体感でしか判定できないものは、
✅ を付けずに「ユーザーへの依頼」へ回すこと。**
`/harness-core:done` の完了報告でも、体感確認が未了なら「動作確認」行を ✅ にしない。
