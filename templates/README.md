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
> claude plugin install harness-core@dev-harness  --scope project
> claude plugin install harness-<env>@dev-harness --scope project
> ```
>
> **`--scope project` を省略しない。** 既定の `user` に入れると、`enabledPlugins` が作る
> `project` 側の登録と二重になり、更新のたびに両方へ当てることになる。
>
> 導入できたかは **`/plugin`（enabled とバージョン）** と **`/`（スキル一覧）** で確認する。
> SessionStart フックは harness-core 0.5.0 以降 `[harness] <env> / config OK` を**画面に1行出す**ので、
> 出なければ導入できていない（または config が読めていない）と言える。
> ただし**版が古いままでも出る**ため、確認は `/plugin` と `/` を正とすること。
>
> 詳細は [../docs/guide/セットアップガイド.md](../docs/guide/セットアップガイド.md)。

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

## `settings.json` と `settings.local.json` の使い分け

テンプレートが配るのは **`.claude/settings.json` だけ**。`settings.local.json` は生成されない
（`.gitignore` 対象で、必要になった人が手元で作る）。

| ファイル | Git 管理 | 置くもの |
|---------|---------|---------|
| `.claude/settings.json` | **する**（派生プロジェクトへ伝播する） | **deny は全部ここ**。共有すべき allow / ask、hooks、`enabledPlugins` |
| `.claude/settings.local.json` | しない | **手元だけの allow**（個人の作業効率化）、個人的な env |

**セキュリティに関わる設定を `settings.local.json` に置かない。** 共有されないため、
そこから派生したプロジェクトが無防備になる（Phase 0 の発見事項 F1。WPF テンプレートで実際に起きた）。

テンプレート既定の制限がきつすぎる場合も、`settings.json` の deny を削るのではなく
`settings.local.json` の allow で手元だけ緩める。方針の正典は
[../docs/reference/permissionsベースライン.md](../docs/reference/permissionsベースライン.md) §1。

## 追加・変更するときの注意

- **業務固有名・実プロジェクト由来の固有値を入れない**（本リポジトリは public）
- `docs/設計書/` に置くのは**ヘッダと表の枠だけ**。サンプルの実データを残さない
- permissions の方針は [../docs/reference/permissionsベースライン.md](../docs/reference/permissionsベースライン.md) が正典
  （実機検証済みのパターンが記録されている）
