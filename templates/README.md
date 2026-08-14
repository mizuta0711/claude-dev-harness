# templates/ — テンプレート層

プラグインでは配布できないもの（CLAUDE.md / `constitution.md` / `.claude/rules/` /
`docs/` 骨格 / `.claude/settings.json` / `.claude/harness.config.json` / `.gitignore` / `.mcp.json`）を
**プロジェクト生成時にコピーする層**。

```
templates/
├── base/     # 全環境共通
├── nextjs/   # 環境差分
├── unity/
└── wpf/
```

生成は [`../tools/create-project.mjs`](../tools/create-project.mjs) が行う:

```bash
node tools/create-project.mjs --env <nextjs|unity|wpf> --dest ../MyProject
```

> **生成後にプラグインの導入が要る。**
> テンプレートが書き込む `.claude/settings.json` の `extraKnownMarketplaces` は
> marketplace の登録・クローンを初回起動で自動で行うが、
> **初回起動ではプラグインが導入されない**（実測・2026-08-14）。生成先で一度だけ実行する:
>
> ```bash
> claude plugin install harness-core@dev-harness
> claude plugin install harness-<env>@dev-harness
> ```
>
> 導入できたかは起動時の `[harness] environment: <env>` の表示で判別する。

## 合成のルール

| 対象 | 合成方法 |
|------|---------|
| `CLAUDE.md` | base の `<!-- ENV_SECTION -->` マーカーを、env の `CLAUDE.section.md` の内容で置換する |
| `.claude/settings.json` | deep-merge（オブジェクトは再帰マージ、配列は連結 + 重複除去） |
| `.gitignore` | base + env の連結 |
| その他 | env が base を上書きする |

生成先へは**コピーされない**テンプレート層のメタファイル:

| ファイル | 役割 |
|---------|------|
| `<env>/template.json` | その環境が要求するプレースホルダの宣言（`create-project` が読む） |
| `<env>/CLAUDE.section.md` | `CLAUDE.md` へ埋め込まれる環境セクションの原稿 |

## プレースホルダ

`{{PROJECT_NAME}}` のような `{{KEY}}` 形式。**ファイルの内容だけでなくパスにも適用される。**
どのキーを要求するかは `<env>/template.json` の `placeholders` が宣言する。

| 環境 | プレースホルダ |
|------|---------------|
| nextjs | `PROJECT_NAME` / `PROJECT_DESCRIPTION` |
| unity | `PROJECT_NAME`（C# の root namespace を兼ねる） / `PROJECT_DESCRIPTION` |
| wpf | `PROJECT_NAME` / `PROJECT_DESCRIPTION` / `CORE_PROJECT` / `UI_PROJECT` |

`placeholders[].default` は既に決まった値を参照できる（例: wpf の `CORE_PROJECT` の既定値は
`{{PROJECT_NAME}}.Core`）。

## 置いていないもの（意図的）

| 対象 | 理由 |
|------|------|
| `docs/features/TEMPLATE.md` | `harness-core` の `new-feature` スキル同梱版を正とする（二重管理の防止）。プロジェクト固有の調整が必要になったプロジェクトだけが `docs/features/TEMPLATE.md` を自前で置く — スキルはそれを優先する |
| `.claude/hooks/` | hooks はプラグイン（`harness-core` / `harness-<env>`）が配信する |
| `.claude/skills/` / `.claude/agents/` | 同上。名前空間付き（`/harness-core:<name>`）で提供される |

## 追加・変更するときの注意

- **業務固有名・実プロジェクト由来の固有値を入れない**（本リポジトリは public）
- `docs/設計書/` に置くのは**ヘッダと表の枠だけ**。サンプルの実データを残さない
- permissions の方針は [../docs/permissions-baseline.md](../docs/permissions-baseline.md) が正典
  （実機検証済みのパターンが記録されている）
