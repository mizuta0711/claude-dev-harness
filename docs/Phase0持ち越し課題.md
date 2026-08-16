# Phase 0 由来の持ち越し課題（F1〜F7 / R1〜R5）

| 項目 | 内容 |
|------|------|
| 出典 | ProjectTemplete `docs/reviews/20260814_094140_phase0-fixes.md`（F1〜F7）および `20260814_094949_phase0-fixes_レビュー.md`（R1〜R5） |
| 目的 | Phase 0 で「発見のみ・修正せず」とした項目を、どのフェーズのどの成果物で解消するかを固定する |
| 優先順位（ユーザー指示） | F1 > R1・R2・R3・F3・F7 > その他 |

## 1. 割り当て一覧

| # | 内容 | 解消先 | 状態 |
|---|------|--------|------|
| F1 | WPF の deny が `settings.local.json`（gitignore 対象）にのみ存在し派生へ伝播しない | ① 既存 WPF リポジトリ: Phase 0 追補として適用済み（branch `phase0-f1`）<br>② 恒久: Phase 2 の `templates/*/settings.json` 雛形（[permissionsベースライン.md](permissionsベースライン.md) §1） | ✅ 既存反映済み / ⬜ 雛形は Phase 2 |
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

- [ ] `templates/base/.claude/settings.json` に [permissionsベースライン.md](permissionsベースライン.md) の deny / ask を実装する
- [ ] 同 §5 の未検証3項目を実機で確認し、効かないパターンは書き直す
- [ ] `templates/<env>/.claude/settings.json` の allow を、その環境の `harness.config.json` の `commands` と一致させる
- [ ] `settings.local.json` は「手元だけの allow」用途であることをテンプレートの README に明記する

## CommSim 由来の還元候補 — 判断結果（2026-08-15）

成熟した WPF/.NET 8 プロジェクトを調査して提案された4件の判断。
調査側の結論「巻き戻す価値のある共通資産は無い。4件はいずれも CommSim にしか無いもの」は
全量突き合わせ済みで、既存資産の上書きは発生しない。

| # | 候補 | 判断 |
|---|------|------|
| A | 日本語校正（`japanese-proofreader` + `proofread-ja`） | **採用（実施済み・harness-core 0.4.0）** |
| B | `docs/handoff/` の追加 | **採用（実施済み）** |
| C | `docs/features/rejected/` の追加 | **不採用** |
| D | リリースノートの書き方の規律 | **不採用** |

### A — 採用。縮小して実装した（✅ harness-core 0.4.0）

harness の成果物（`docs/features/` の設計書・`docs/reviews/` の記録・CLAUDE.md）は
**ほぼ全量が AI の書いた日本語**で、しかも長期間残る。環境非依存の共通課題であり core の責務に合う。
位置づけは「校正」ではなく **「AI が書いた文章の品質ゲート」**とする。

移植時の判断3点:

1. **`model: fable` の固定はしない。** モデル名は将来変わる。ハーネスが特定モデル名を持つと、
   名前が変わった時点で全プロジェクトが壊れる。`description` に「文章品質が要るため上位モデルを推奨」と
   書き、**モデル指定はプロジェクト側の裁量**にする
2. **パターン表（7分類）は core に持つ。** 「空表をテンプレートに置いて育てさせる」案は採らない。
   C1 で `ORDERED_TABLES` が空 TODO のまま放置されて事故になった（#8）のと同じ構造で、
   **空の器は埋められない**
3. プロジェクト固有の用語統一は `.claude/rules/` へ寄せる

**実装結果（2026-08-15・harness-core 0.4.0）**: 判断3点はすべてそのとおりに実装した。

- `agents/japanese-proofreader.md` — **`model` の項目を持たない**。「上位モデルを推奨」は `description` に書き、
  指定はプロジェクトの裁量とした。7分類のパターン表は core に持たせ、CommSim 固有の例は
  一般的な言い回しへ置き換えた（本リポジトリは public のため）
- `skills/proofread-ja/SKILL.md` — 対象の決定 → 委譲 → **メインでの差分レビュー（必須）** → コミット。
  **`CHANGELOG.md` と改訂履歴を対象外**にした（過去の記録は書き換えない）
- 新しく見つかったパターンは、プロジェクト固有なら `.claude/rules/`、
  環境非依存ならハーネスへ還元、と行き先を明記した

### C — 不採用（理由）

`completed/` と `pending/` が既にあり、**却下はタスク単位（`❌却下`・理由必須）で足りている**のが
C1 の実績。実際に却下されたタスク（`prisma migrate reset` の実行）もタスク行で処理でき、
設計書ごと却下する場面は発生しなかった。**器を増やすと運用の分岐が増える**割に、
埋まる見込みが立っていない。必要になった時点で追加する（YAGNI）。

### D — 不採用（理由）

ハーネス自身は `CHANGELOG.md` を持ち、semver 運用も回っている（版番号の運用は
`docs/プラグイン開発手順.md` に集約済み）。**利用側プロジェクトにリリースノートが要るかは
プロダクトの性質に依存**し、環境非依存の共通課題ではない。core の責務から外れる。
