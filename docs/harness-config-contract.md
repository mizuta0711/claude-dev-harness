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

  "verification": { "skill": "browser-test", "manualGate": false }
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
| `docTriggers[].pattern` が不正な正規表現 | そのトリガーだけ無視して継続 | — |
| `git` が使えない / 初回コミットで `HEAD~1` が無い | 素通り | — |

## 4. パスの扱い

- `docTriggers[].pattern` は **リポジトリルートからの相対パス・フォワードスラッシュ**に対して評価する
- Windows のパス区切り `\` は評価前に `/` へ正規化する（`harness-lib.toPosix`）
- config 自体は UTF-8（BOM 無し）。実装は先頭の BOM を除去してからパースする

## 5. プロジェクトルートの解決

hook は `CLAUDE_PROJECT_DIR` 環境変数があればそれを、無ければ `process.cwd()` をプロジェクトルートとして扱う
（`harness-lib.projectDir`）。config・git 操作・設計書の探索はすべてこのルート基準で行う。
