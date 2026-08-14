---
name: harness-update
description: テンプレート層（CLAUDE.md / constitution.md / .claude/rules/ / harness.config.json / docs 骨格）を claude-dev-harness の最新へ追従させる。差分を3分類で提示し、ユーザー承認を得たものだけを適用する。
disable-model-invocation: true
allowed-tools: "Bash(node:*), Read, Glob, Grep"
---

# テンプレート層の追従（harness-update）

プラグイン（skills / agents / hooks）は marketplace 経由で自動更新されるが、
**CLAUDE.md / `constitution.md` / `.claude/rules/` / `.claude/harness.config.json` / `docs/` 骨格は
プロジェクト生成時のコピー**であり、そのままでは改善が伝播しない。
その差分を検出し、**ユーザー承認のうえで**適用するのがこのスキル。

差分の判定は同梱の `scripts/harness-diff.mjs` が機械的に行う。
**目視で差分を分類しないこと** — 3点比較はスクリプトの仕事。

## 大原則

- **プロジェクト側のローカル改変を無断で上書きしない**
- 適用はファイル単位でユーザーの承認を取る。競合はハンク単位で提示する
- ネットワーク不通などで取得できない場合は**中断して報告**する。作業自体は止めない

## Step 1: 解析

```bash
node "${CLAUDE_SKILL_DIR}/scripts/harness-diff.mjs" analyze
```

スクリプトは次を行う:

1. `.claude/harness.config.json` の `environment` と `.claude/harness-baseline.json` を読む
2. claude-dev-harness を `git clone --depth 1` で一時取得する（public なので認証不要）
3. **クローン側の `tools/create-project.mjs` を実行して「あるべき姿」を再現する**
   - **B** = 最新コミットでの生成結果
   - **A** = baseline コミットでの生成結果（`--depth 1` に無ければそのコミットだけ追加 fetch する）
   - 置換値は baseline の `placeholders` を再利用する
4. **C**（プロジェクトの現物）と3点比較して分類する

### オフライン・開発時

ローカルクローンを使うとネットワークを使わない:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/harness-diff.mjs" analyze --repo /path/to/claude-dev-harness
```

### baseline が無いプロジェクト（Phase 2 以前の生成物）

`placeholders` が分からないため、**そのままでは差分が過剰に出る**。
スクリプトが警告を出すので、`CLAUDE.md` 等から実際の値を読み取って渡し直すこと:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/harness-diff.mjs" analyze \
  --set PROJECT_NAME=MyApp --set PROJECT_DESCRIPTION="..." \
  --set CORE_PROJECT=MyApp.Core --set UI_PROJECT=MyApp.UI
```

この場合は A が無いため**2点比較**になり、差分は全て「競合」として提示される（安全側に倒している）。

## Step 2: 分類の提示

スクリプトの出力をそのままユーザーへ流さず、**次の形に整理して提示する**:

| 分類 | 意味 | 既定の扱い |
|------|------|-----------|
| `template-improvement` | テンプレート側だけが変わった（A≠B かつ A=C） | **適用を提案** |
| `project-local` | プロジェクト側だけが変わった（A=B かつ A≠C） | **保持**（触らない） |
| `already-applied` | 同じ変更が既に入っている（B=C） | 対応不要 |
| `conflict` | 両方が同じファイルを変更した | **ユーザー判断が必須** |
| `template-removed` | テンプレートから消えたファイル | 判断（削除するか残すか） |

各ファイルについて、**何が変わるのかを1行で説明する**こと。
ファイル名の羅列だけでは承認の judgement ができない。差分の中身は
`{workDir}/latest/<path>`（B）と現物を Read して要約する。

## Step 3: 承認と適用

### template-improvement

まとめて提示し、**ユーザーが承認したものだけ**を適用する:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/harness-diff.mjs" apply CLAUDE.md .claude/rules/typescript.md
```

### conflict

`apply` を使わない。A / B / C の3つを Read して**ハンク単位で提示**し、
どちらを採るか（あるいは統合するか）をユーザーに決めてもらってから Edit で書く。

- A: `{baselineDir}/<path>` — 前回適用時のテンプレート
- B: `{idealDir}/<path>` — 最新のテンプレート
- C: プロジェクトの現物

### harness.config.json

**ファイル全体を上書きしない。** スクリプトが出す**スキーマ差分**に従う:

- 新フィールド → 既定値つきで追加を提案する（既存の値は保持）
- 消えたフィールド → 非推奨の可能性を伝え、削除するかを確認する
- `schemaVersion` の引き上げ → **マイグレーション内容を提示してユーザー承認を取る**。無断で上げない

### 追従対象外（スクリプトが自動で除外する）

`docs/features/` / `docs/reviews/` / `docs/設計書/`（`.doc-sync.md` を除く）は
**プロジェクトの資産**であり、テンプレートが上書きしてはいけない。

## Step 4: 記録

適用が終わったら baseline を更新する:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/harness-diff.mjs" finalize
```

`templatesCommit` が最新コミットへ更新され、作業ディレクトリ（`.claude/.harness-update/`）が削除される。

> **競合を「後で対応する」まま finalize しない。** baseline が進むと、
> 次回の解析でその競合は差分として見えなくなる（A=B になるため）。
> 未対応の競合が残る場合は finalize せずに報告し、対応後に改めて実行する。

## Step 5: 報告

```markdown
### ハーネス追従（harness-update）結果

| 項目 | 内容 |
|------|------|
| 取得元 | {URL または --repo のパス} |
| baseline | {前回のコミット} → {最新のコミット} |
| 適用 | N 件 |
| 保持（プロジェクト固有） | N 件 |
| 競合 | N 件（対応済み / 未対応の内訳） |
| config スキーマ変更 | {あれば内容。無ければ「なし」} |

#### 適用した変更
- `<path>` — {何が変わったか}

#### 保持した改変
- `<path>` — {プロジェクト固有の内容}

#### 未対応（あれば）
- `<path>` — {理由。baseline は更新していない旨も書く}
```

最後に、**適用した差分をユーザーが確認してからコミットするよう促す**こと
（このスキルはコミットしない）。
