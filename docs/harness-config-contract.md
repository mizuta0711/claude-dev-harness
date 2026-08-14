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
