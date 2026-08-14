# Phase 0 由来の持ち越し課題（F1〜F7 / R1〜R5）

| 項目 | 内容 |
|------|------|
| 出典 | ProjectTemplete `docs/reviews/20260814_094140_phase0-fixes.md`（F1〜F7）および `20260814_094949_phase0-fixes_レビュー.md`（R1〜R5） |
| 目的 | Phase 0 で「発見のみ・修正せず」とした項目を、どのフェーズのどの成果物で解消するかを固定する |
| 優先順位（ユーザー指示） | F1 > R1・R2・R3・F3・F7 > その他 |

## 1. 割り当て一覧

| # | 内容 | 解消先 | 状態 |
|---|------|--------|------|
| F1 | WPF の deny が `settings.local.json`（gitignore 対象）にのみ存在し派生へ伝播しない | ① 既存 WPF リポジトリ: Phase 0 追補として適用済み（branch `phase0-f1`）<br>② 恒久: Phase 2 の `templates/*/settings.json` 雛形（[permissions-baseline.md](permissions-baseline.md) §1） | ✅ 既存反映済み / ⬜ 雛形は Phase 2 |
| F2 | PowerShell の破壊的コマンド deny が引数順序に依存 | Phase 2 雛形（同 §2。`Remove-Item*-Recurse*` 形式） | ⬜ Phase 2（実機確認つき） |
| F3 | refspec 形式の force push（`git push origin +main`）を塞げない | Phase 2 雛形（同 §2） | ⬜ Phase 2（実機確認つき） |
| F4 | hooks が `if` 非依存でなく、全 Bash 呼び出しで起動する | **Phase 1 で解消済み**。matcher は `Bash\|PowerShell`、発火判定は stdin JSON を各スクリプトで実施（`harness-lib.isGitCommit`） | ✅ 完了 |
| F5 | Unity の C# チェックが namespace `YourApp` をハードコード | ロジックは config に入れない方針（04仕様 §5）。`harness-unity` プラグインの hook としてプレースホルダ化する | ⬜ Phase 3 |
| F6 | nextjs `docs/guide/バイブコーディング運用ガイド.md` の rules 発火条件が旧表記 | 既存テンプレートの表記修正（アーカイブする場合は不要） | ⬜ Phase 3 |
| F7 | `Bash(git push:*)` が allow で無確認 push が通る | Phase 2 雛形で `ask` へ（同 §3） | ⬜ Phase 2 |
| R1 | 「4. ブラウザ評価計画」の旧参照が nextjs の現役3ファイルに残存 | ① **Phase 1 で再発防止**: core の TEMPLATE.md とスキルは節番号でなく**見出し名で参照**する（`design-review` Step 2 に明記）<br>② 既存3ファイルの修正は Phase 3 | ✅ 予防済み / ⬜ 既存は Phase 3 |
| R2 | T1 で Unity にも `Bash(git push:*)` allow が入り F7 が波及 | F7 と同じ（Phase 2 雛形は nextjs / unity 両方が対象） | ⬜ Phase 2 |
| R3 | `grep` / `Select-String` 経由で `.env` が読める（Read deny の波及対象外） | Phase 2 雛形（同 §2） | ⬜ Phase 2（実機確認つき） |
| R4 | `${1:-1}` はハーネスの引数置換にマッチせず引数が届かない | **Phase 1 で解消済み**。core `update-docs` は frontmatter `arguments: [depth]` + `$depth` 方式。SKILL.md にシェル位置パラメータ禁止を明記 | ✅ 完了 |
| R5 | `.env` deny の列挙が変種（`.env.staging` 等）を拾えない。`Edit` 側も変種が対象外 | Phase 2 雛形で `Read(./.env*)` / `Edit(./.env*)` に一本化（同 §2） | ⬜ Phase 2 |

## 2. Phase 1 で解消した2件の実装位置

| # | ファイル | 該当箇所 |
|---|---------|---------|
| F4 | `plugins/harness-core/hooks/hooks.json` | matcher が `Bash\|PowerShell` のみ。`if` フィールドを使っていない |
| F4 | `plugins/harness-core/hooks/scripts/harness-lib.js` | `isGitCommit()` で `tool_input.command` を判定。各 hook が先頭で呼ぶ |
| R4 | `plugins/harness-core/skills/update-docs/SKILL.md` | frontmatter `arguments: [depth]`、本文で `$depth` を使用。「シェルの位置パラメータは置換されないため使わない」と明記 |
| R1 | `plugins/harness-core/skills/design-review/SKILL.md` | Step 2 で「見出し名で検索する（番号で検索しない）」と規定 |

## 3. Phase 2 着手時のチェックリスト

- [ ] `templates/base/.claude/settings.json` に [permissions-baseline.md](permissions-baseline.md) の deny / ask を実装する
- [ ] 同 §5 の未検証3項目を実機で確認し、効かないパターンは書き直す
- [ ] `templates/<env>/.claude/settings.json` の allow を、その環境の `harness.config.json` の `commands` と一致させる
- [ ] `settings.local.json` は「手元だけの allow」用途であることをテンプレートの README に明記する
