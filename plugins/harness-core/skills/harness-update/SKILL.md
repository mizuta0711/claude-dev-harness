---
name: harness-update
description: "テンプレート層（CLAUDE.md / rules / harness.config.json / docs 骨格）を claude-dev-harness の最新に追従させる。※ Phase 3 で実装予定の骨子のみ"
disable-model-invocation: true
---

# テンプレート層の追従（harness-update）

> **状態: 骨子のみ（未実装）。実装は Phase 3。**
> このスキルを呼び出した場合は、「未実装である」ことを伝え、
> 現時点では手動での差分適用が必要である旨を案内すること。

## 目的

プラグイン（skills / agents / hooks）は marketplace 経由で自動更新されるが、
**CLAUDE.md / `.claude/rules/` / `.claude/harness.config.json` / `docs/` 骨格は
プロジェクト生成時のコピー**であり、そのままでは改善が伝播しない。

その差分を検出し、ユーザー承認のうえで適用するのがこのスキルの役割。
Next.js 版テンプレートにあった「派生プロジェクト適用手順」（長大な手動プロンプト集）の置き換えにあたる。

## 手順（実装予定）

### Step 1: 最新テンプレートの取得

- `claude-dev-harness` の `templates/base` と `templates/<environment>` を取得する
- `<environment>` は `.claude/harness.config.json` の `environment` を使う
- 取得手段（git clone / sparse-checkout / プラグイン同梱）は Phase 3 で確定する

### Step 2: 差分の提示

- プロジェクト側の対応ファイルと比較し、差分を3分類で提示する:
  - **テンプレート側の改善**（取り込むべき差分）
  - **プロジェクト固有の改変**（保持すべき差分）
  - **競合**（同じ箇所を両方が変更している。ユーザー判断が必要）
- `harness.config.json` は**スキーマ差分**（新フィールドの追加・非推奨化）として扱い、値は保持する

### Step 3: 承認と適用

- ファイル単位・ハンク単位でユーザーの承認を取る
- **プロジェクト側のローカル改変を無断で上書きしない**
- 適用後、変更点のサマリを報告する

### Step 4: 記録

- 適用したテンプレートのバージョン（コミット）をプロジェクト内に記録し、次回の差分計算の基準にする

## 実装時の要検討事項

| # | 論点 |
|---|------|
| 1 | テンプレート取得の手段（ネットワーク前提にするか、プラグイン同梱にするか） |
| 2 | 適用済みバージョンの記録先（`.claude/harness.config.json` に持たせるか、別ファイルか） |
| 3 | `schemaVersion` が上がった場合の config マイグレーション手順 |
