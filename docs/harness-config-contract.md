# `.claude/harness.config.json` 設定契約（harness-core 実装版）

| 項目 | 内容 |
|------|------|
| 対応 schemaVersion | `1` |
| 正典 | ProjectTemplete リポジトリ `docs/04_harness設定契約_仕様.md` |
| 本書の役割 | 04仕様のうち **harness-core が実際に読むフィールド**と、その挙動を実装側から記述したもの |

## 1. スキーマ（schemaVersion: 1）

```jsonc
{
  "schemaVersion": 1,
  "environment": "nextjs",             // nextjs | unity | wpf | (将来追加)

  "commands": {                        // null = この環境には無い
    "build":     "npm run build",
    "typecheck": "npx tsc --noEmit",
    "lint":      "npm run lint",
    "format":    null,
    "test":      null,
    "dev":       "npm run dev"
  },

  "gates": { "preCommit": ["typecheck"] },   // 空配列 = コミット前ゲート無し

  "paths": {
    "source": ["src/**"],
    "docTriggers": [
      { "pattern": "^src/app/api/", "docs": ["API一覧.md"] }
    ]
  },

  "projectDocs": {                     // 任意。プロジェクトが育てる文書の場所（§8）
    "requirements": [],                //   要件・ドメイン知識（Stage 1 で読む）
    "policy": [".claude/01_development_docs", ".claude/02_design_system"]  // 設計方針（Stage 2 で読む）
  },

  "designDocs": {
    "dir": "docs/設計書",
    "ledger": "docs/設計書/.doc-sync.md",
    "docs": [
      { "file": "API一覧.md", "tracks": "APIエンドポイントの一覧", "sources": ["src/app/api/**"] }
    ]
  },

  "verification": { "skill": "browser-test", "manualGate": false },

  "envOptions": {                      // 任意。環境プラグイン専用の設定置き場（§7）
    "rootNamespace": "MyGame"
  }
}
```

## 2. 消費者一覧（実装との対応）

| フィールド | 消費者 | 実装上の挙動 |
|-----------|--------|-------------|
| `schemaVersion` | 全 hook（`harness-lib.loadConfig`） | 数値でなければ `invalid`。core の対応版（現在 1）より大きければ `newer` として**素通り**する |
| `environment` | `session-start-context.js` | SessionStart の additionalContext に表示するのみ |
| `commands.*` + `gates.preCommit` | `pre-commit-check.js` | `gates.preCommit` の各キーを `commands` から引き、非 null のものを順に実行。1つでも失敗したら `permissionDecision:"deny"` でブロック |
| `commands.*` | `build-check` スキル | 非 null を `typecheck → build → lint → format → test` の順で実行。`dev` は実行しない |
| `paths.docTriggers` | `post-commit-doc-check.js` | 直近コミットの変更ファイル（`/` 正規化済み）を `pattern` の正規表現で判定し、一致した `docs` を通知 |
| `paths.source` | `pre-push-check` スキル | ソース変更を含まないコミットを台帳チェックから SKIP |
| `designDocs.*` | `update-docs` / `sync-check` / `complete-feature` スキル | 照合対象の決定（`sources`）、粒度の決定（`tracks`）、記録先（`ledger`） |
| `projectDocs.requirements` | `new-feature`（Step 2）/ `design-review feature` | Stage 1 の前にドメイン制約・ビジネスルールを読む。**未登録・空なら素通り** |
| `projectDocs.policy` | `new-feature/TEMPLATE.md`（§4）/ `design-review tech` / `complete-feature`（ゲート3） | Stage 2 が既存の設計方針に反していないかを検査し、新たな設計判断を**完了時に書き戻させる**。**未登録・空なら素通り** |
| `verification.*` | `done` / `code-review` スキル | 完了報告の「動作確認」行、レビュー後のリマインド文 |

## 3. fail-open の挙動（実装が保証すること）

| 状況 | hook の挙動 | skill の挙動 |
|------|------------|-------------|
| config が存在しない | `exit 0` で素通り。ただし SessionStart のみ**警告を注入** | 「設定不在」として1行報告して終了 |
| JSON が壊れている | 同上 | 同上 |
| `schemaVersion` が core より新しい | 警告メッセージを出して素通り | 同左 |
| `gates.preCommit` が空 / 対象 `commands` が null | 素通り（メッセージも出さない） | 「この環境に CLI チェックは無い」と報告 |
| `gates.preCommit` のキーが `commands` に**存在しない**（typo 疑い） | 警告を出しつつ、そのキーはスキップして続行（ブロックしない） | — |
| `docTriggers[].pattern` が不正な正規表現 | そのトリガーだけ無視して継続 | — |
| `git` が使えない / 初回コミットで `HEAD~1` が無い | 素通り | — |
| `git reflog` が読めない | post-commit-doc-check は従来どおり判定に進む（通知が死ぬより誤通知を許容） | — |

**例外（fail-open ではない箇所）**: コミット前ゲートのコマンドがタイムアウトした場合は
「実行したが結果が得られなかった」ではなく **失敗として deny する**（§6 参照）。

## 4. パスの扱い

- `docTriggers[].pattern` は **リポジトリルートからの相対パス・フォワードスラッシュ**に対して評価する
- Windows のパス区切り `\` は評価前に `/` へ正規化する（`harness-lib.toPosix`）
- config 自体は UTF-8（BOM 無し）。実装は先頭の BOM を除去してからパースする

## 5. プロジェクトルートの解決

hook は `CLAUDE_PROJECT_DIR` 環境変数があればそれを、無ければ `process.cwd()` をプロジェクトルートとして扱う
（`harness-lib.projectDir`）。config・git 操作・設計書の探索はすべてこのルート基準で行う。

## 6. hook の時間予算とイベント登録（実装上の決定）

### 6-1. コミット前ゲートの時間予算

タイムアウトした PreToolUse hook は **ブロックせずツール実行が続行される**（公式仕様）。
つまり hook 自体がタイムアウトすると、ゲートは静かに無効化される。これを避けるため:

| 設定 | 値 | 意味 |
|------|----|------|
| `hooks.json` の timeout | 600 秒 | command hook の既定上限 |
| `harness-lib.TOTAL_BUDGET_MS` | 570 秒 | 起動・出力のマージンを引いた hook 全体の予算 |
| `harness-lib.MAX_COMMAND_MS` | 170 秒 | 1コマンドの上限 |

各コマンドのタイムアウトは `min(MAX_COMMAND_MS, 残り予算 / 残りコマンド数)`。
実行のたびに実測経過時間を予算から差し引く。
**コマンドがタイムアウトした場合は失敗扱いで `deny` する**（理由の先頭にタイムアウトである旨を明記）。
これにより「重いゲートを2つ以上設定すると無検査でコミットが通る」状態を作らない。

### 6-2. コミットの成立確認（2段構え）

`git commit` の呼び出しがあっても、実際にコミットが作られたとは限らない
（ステージ無し、外部 pre-commit hook の拒否、`--dry-run` など）。
`post-commit-doc-check.js` は次の順で「本当にコミットされたか」を確認する:

| 段 | 判定材料 | 挙動 |
|----|---------|------|
| 1 | `.claude/.pre-commit-head`（`pre-commit-check` が同じ `git commit` の直前に記録した HEAD） | 現在の HEAD と同じ = コミットされていない → 素通り。異なる → 判定に進む |
| 2 | 記録が無い場合のみ `git reflog -1 --format=%gs` | `commit:` / `commit (amend):` / `commit (initial):` で始まる → 判定に進む。それ以外 → 素通り |
| 3 | どちらも判断材料が無い | 判定に進む（fail-open。通知が誤る可能性より、通知が完全に死ぬことを避ける） |

`.claude/.pre-commit-head` は PostToolUse 側が読んだ時点で削除する。プロジェクトの `.gitignore` に
加えてよい（無くても段2・段3で動作する）。

### 6-3. サブエージェントの記録の受け渡し（`.claude/.subagent-touch.json`）

**SubagentStop には通知経路が無い**（下の「通知の届き方」を参照）。そこで
`subagent-stop-diff` は**通知せずに記録だけ残し**、`pre-commit-check` が
**コミットしようとした瞬間**に読み出して通知へ添える。

| 段 | 誰が | 何をする |
|----|------|---------|
| 1 | `subagent-stop-diff`（SubagentStop） | 変更があれば `{agent, files}` を**追記**する。上限20件 |
| 2 | `pre-commit-check`（PreToolUse・`git commit` 時） | 読んで消し、通知の末尾に「差分を確認してからコミットすること」を添える |
| 3 | 同（**ブロックした場合**） | 記録を**書き戻す**。コミットは成立していないため、次の試行でも出す |

`.gitignore` に加えること（テンプレートには入れてある）。**無くても全体は動く**（fail-open）。

### 6-4. 通知の届き方（2026-08-15 実測・Claude Code v2.1.232）

| イベント | `systemMessage`（画面） | `additionalContext`（Claude の文脈） |
|---------|------------------------|-----------------------------------|
| SessionStart | ✅ | ✅ |
| PreToolUse | ✅ | ✅ |
| PostToolUse（Bash / Edit / Write / Task） | ✅ | ✅ |
| SubagentStop | ❌ | ❌ 親には届かない。**サブエージェント自身へ戻り、停止をキャンセルしてループする** |

- 通知は **`lib.notify(hookEventName, message)` で2経路とも出す**のが既定。片方に賭けない
- **SubagentStop で `notify` を使ってはいけない**（ループする）
- PostToolUse（`Task`）は**サブエージェントが背景実行の場合、起動直後に発火する**ため、
  「終了時点の変更ファイル数」を出す用途には使えない

> **実測メモ**: 現行の Claude Code では **Bash ツールが非ゼロ終了した場合 PostToolUse hook は発火しない**
> （同一セッションで失敗コミットは発火せず、成功コマンドは発火することを確認）。
> したがって単純な失敗コミットでは誤通知は起きないが、`git commit --dry-run` や
> `git commit ... || true` のように**成功終了しつつコミットを作らない**ケースは実在するため、
> 段1・段2 の確認は必要。

### 6-3. SessionStart の matcher

`startup|resume|clear|compact` を対象にする。
`fork` は**意図的に含めない** — fork 元セッションの文脈を引き継ぐため、状況の再注入は冗長になる。

## 7. `envOptions`（任意フィールド・環境プラグイン専用）

環境プラグインの hook が必要とする「値」を置くための**任意**フィールド。

| 項目 | 内容 |
|------|------|
| 必須か | **任意**。無くてよい |
| schemaVersion | **1 のまま**（追加は任意フィールドであり、参照側は未知フィールドを無視するため互換） |
| 読む主体 | **環境プラグインの hook のみ**。harness-core は一切読まない |
| 無い場合の挙動 | **その検査だけをスキップする（fail-open）**。ブロックしない |

`commands` / `gates` のような「全環境共通の軸」に載らない環境固有の値をここへ逃がす。
**ロジックは入れない**（ロジックは環境プラグインの実装として持つ — 04仕様 §1-3 の原則は変わらない）。

### 現在の利用箇所

| キー | 環境 | 消費者 | 挙動 |
|------|------|--------|------|
| `envOptions.rootNamespace` | unity | `harness-unity` の `pre-commit-cs-check.js` | ステージ済み `Assets/Scripts/**/*.cs` に `namespace <値>` が宣言されているかを検査し、未宣言なら**警告**（ブロックはしない）。**キーが無ければ namespace 検査自体をスキップ**し、その旨をメッセージに添える |

Unity テンプレートでは `create-project` が `"rootNamespace": "{{PROJECT_NAME}}"` を生成時に実値へ置換する。
これにより、移植元の Unity テンプレートにあった **namespace `YourApp` のハードコード**（Phase 0 発見事項 F5）が解消されている。

## 8. `projectDocs`（任意フィールド・プロジェクトが育てる文書の場所）

**「これから何に従うか」を書いた文書の場所**をスキルへ教えるための**任意**フィールド。
`designDocs`（＝**実装の現況**）とは別物なので混同しないこと。

| 項目 | 内容 |
|------|------|
| 必須か | **任意**。無くてよい |
| schemaVersion | **1 のまま**（`envOptions` と同じ扱い） |
| 読む主体 | **スキルのみ**（`new-feature` / `design-review` / `complete-feature`）。hook は一切読まない |
| 無い場合の挙動 | **その導線だけをスキップする（fail-open）**。ブロックしない |

| キー | 中身 | 読まれる場面 |
|------|------|-------------|
| `requirements` | 要件・ドメイン知識（`.claude/00_project/` 等） | **Stage 1**（機能・画面設計）。`new-feature` Step 2 と `design-review feature` |
| `policy` | このプロジェクトの設計方針（`.claude/01_development_docs/` `02_design_system/` 等） | **Stage 2**（技術設計）。`TEMPLATE.md` §4、`design-review tech`、`complete-feature` ゲート3 |

いずれもディレクトリパスの配列。既定値は環境テンプレートが持つ（`requirements` は空、
`policy` は設計方針層のディレクトリ）。

### `designDocs` との違い

| | `designDocs` | `projectDocs.policy` |
|---|---|---|
| 中身 | **実装の現況**（API一覧・ER図・テーブル定義書） | **設計方針**（層構成・依存方向・エラー処理方式） |
| 誰が書くか | 実装のたびに AI が同期する | 設計判断が確定したときに書き戻す |
| 検査の向き | 設計書の記述が実態と食い違っていないか | **Stage 2 が既存の方針に反していないか** |
| 構造 | `{ file, tracks, sources }` のオブジェクト配列 | ディレクトリパスの文字列配列 |
| harness-update | `.doc-sync.md` のみ追従 | **README.md のみ追従**（中身は project-owned） |
