# tools/ — ハーネス自体のツール置き場

| ファイル | 用途 |
|---------|------|
| `create-project.mjs` | `templates/base` + `templates/<env>` を合成して新規プロジェクトを生成する |
| `rules-reality-check.mjs` | 既存プロジェクトの `.claude/rules/` が**実物と食い違っていないか**を検査する（H27） |

**Node 標準ライブラリのみで動く**（依存パッケージを入れない方針）。

## create-project.mjs

```bash
node tools/create-project.mjs --env <nextjs|unity|wpf|android> --dest <生成先パス> [オプション]
```

| オプション | 意味 |
|-----------|------|
| `--set KEY=VALUE` | プレースホルダの値を指定する（複数可。未指定分は対話で尋ねる） |
| `--dry-run` | 生成予定のファイル一覧と置換内容を表示するだけで、何も書き込まない |
| `--yes` / `-y` | 対話プロンプトを出さず、既定値をそのまま使う |

### 処理の流れ

1. `templates/<env>/template.json` からプレースホルダ宣言を読む
2. 値を解決する（`--set` → 既定値 → 対話プロンプトの順）
3. `templates/base` をコピー → `templates/<env>` で上書き
   （合成ルールは [../templates/README.md](../templates/README.md) を参照）
4. 全ファイルの内容とパスの `{{KEY}}` を置換する
5. 未置換のプレースホルダが残っていれば警告する
6. 書き込み → `git init`（既存の `.git` があればスキップ）
7. 次の手順（`claude` 起動 → プラグイン信頼 → `/harness-core:new-feature`）を案内する

### 出力のエンコーディング

UTF-8（BOM 無し）・LF。**`.ps1` のみ UTF-8 BOM 付き**で書き出す
（Windows PowerShell 5.1 が BOM 無し UTF-8 を CP932 と誤読するため）。

### 移植元

WPF テンプレートの `init-template.ps1` の Node 移植版。`--dry-run` は移植元の機能を維持している。
PowerShell ではなく Node にしたのは、hooks が既に Node を要求しており、
Windows・コンテナ・WSL のいずれでも同じ挙動になるため。

## rules-reality-check.mjs

```bash
node tools/rules-reality-check.mjs [--project <dir>] [--json]
```

**既存プロジェクトへ `rules/` を配ったあとに走らせる。**
移行指示書 §10-2 から呼ばれる。

| 検査 | 出るもの | なぜ要るか |
|---|---|---|
| **A** | `paths` が1件も一致しない | **その規約は一度もロードされない。** エラーは出ないので**静かに失敗する** |
| **B** | 名指しした識別子がソースにも依存の宣言にも無い | テンプレートの既定が**そのプロジェクトに当てはまっていない**合図 |

**B は「実在しない」と断定していない。** 候補として出すので、1件ずつ実物で確かめる。
**鳴りすぎる安全弁は外される**（R3）ので、候補の拾い方は保守的に倒してある
（コードスパンの中の**呼び出しの形と注釈だけ**。パス・コマンド・汎用語は拾わない）。

終了コードは**食い違いがあれば 1**、無ければ 0。`--json` で機械可読に出す。
