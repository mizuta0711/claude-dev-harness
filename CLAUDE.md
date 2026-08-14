# claude-dev-harness — 開発ルール

**このファイルは「ハーネス自体を開発するとき」の規律である。**
ハーネスが生成するプロジェクト側の CLAUDE.md（`templates/base/CLAUDE.md`）とは別物なので混同しないこと。

リポジトリの構成・提供物・利用側の手順は [README.md](README.md) にある。ここには複製しない。

## 作業前に読むもの

| 文書 | いつ読むか |
|------|-----------|
| [docs/plugin-development.md](docs/plugin-development.md) | プラグイン（`plugins/`）を直すとき。**反映手順・版番号・スコープ** |
| [docs/harness-config-contract.md](docs/harness-config-contract.md) | `harness.config.json` の契約に触れるとき |
| [docs/background/](docs/background/) | 「なぜこの設計なのか」で迷ったとき |
| [CHANGELOG.md](CHANGELOG.md) | 変更を入れる前後（**書式の規約が冒頭にある**） |

## 1. コミットは必ずパス指定

```bash
git commit -- <path...>      # ○
git add -A && git commit     # ✗ 使わない
git add .   && git commit     # ✗ 使わない
```

**`git add -A` / `git add .` / パス指定なしの `git commit` は使わない。**

理由は「行儀」ではなく実害である。このリポジトリは**複数のセッションが同時に触る**
（還元作業とドキュメント整備が並行するのが常態）。インデックス全体をコミットすると、
**別セッションが編集中のファイルを巻き込んで**、意図しない中途半端な状態が履歴に入る。

> 実際に起きた（`b22c887`）。ドキュメント整備セッションの作業中ファイルを
> 還元セッションのコミットが巻き込んだ。

コミット前に `git status --short` で**自分が触った覚えのないファイルが出ていないか**を確認する。
出ていたら、それは他セッションの作業である。**触らない・含めない・消さない。**

同じ理由で:

- `git checkout -- .` / `git restore .` / `git clean` を**範囲指定なしで使わない**
- `git stash` を使わない（他セッションの変更ごと退避してしまう）

## 2. 版番号を上げないと届かない

プラグイン（`plugins/` 配下）を触ったら、**2ファイルとも**版を上げる。

| ファイル | 場所 |
|---------|------|
| `plugin.json` | `plugins/<plugin>/.claude-plugin/plugin.json` の `version` |
| `marketplace.json` | `.claude-plugin/marketplace.json` の `plugins[].version` |

| 変更内容 | 上げ方 |
|---------|--------|
| スキルの手順追加・新スキル・新フック | minor |
| 文言修正・誤記修正・バグ修正 | patch |
| 設定契約（`schemaVersion`）の変更 | major |

**中身だけ変えて push しても利用側には何も起きない**（`already at the latest version`）。
「push したのに直らない」の原因はほぼこれ。

`templates/` 配下は配信経路が別（`/harness-core:harness-update`）なので版番号は関係しない。
**どちらの層を触っているかを最初に見分けること。**

## 3. push 前に必ず検証する

```bash
claude plugin validate . --strict
```

`plugin.json` と `marketplace.json` の版番号不一致は、**目視レビューでは守れない**種類の不整合である
（実害がすぐ出ないため放置されやすい）。機械的検査に任せる。

`--strict` は warning もエラー扱いにする。push 前のチェックはこちらを使う。

## 4. CHANGELOG は省略しない

変更を入れたら [CHANGELOG.md](CHANGELOG.md) に追記する。**書式の規約は同ファイルの冒頭**にある。

特に各エントリ末尾の **`docs 影響: あり（対象） / なし`** の1行を落とさないこと。
`docs/diagrams/` と `docs/guide/` は自動同期の対象外で、**申告しなければ必ず乖離する**。

## 5. 気づいてもその場で直さない

改善に気づいても**その場では直さず、記録して区切りでまとめて対応する**
（`templates/base/constitution.md` §8 と同じ規律をこのリポジトリにも適用する）。

- 開発の流れを止めないため
- **まとめて直す方が質が上がる。** 1件ずつ直すと場当たりの分岐が増えるが、
  複数件を並べると共通の原因が見えて、より根本的な直し方が選べる

## 6. ファイルの約束

- 全ファイル UTF-8（BOM 無し）・改行 LF（`.gitattributes` で固定）
- **例外: `.ps1` は UTF-8 BOM 付き**。Windows PowerShell 5.1 は BOM 無し UTF-8 を
  CP932 と誤読して日本語が化けるため、BOM が唯一の判別材料になる
- **`templates/` に業務固有名・実プロジェクト由来の固有値を入れない**（本リポジトリは public）
- hooks はすべて Node.js（CommonJS）。PowerShell / Bash スクリプトは使わない
  （Windows・コンテナ両対応のため）

## 7. 直す前に原因を確定する

**推測で直さない。** 想定した原因と実物が食い違うことは実際に起きており、
そのまま直すと**改善のつもりで機能を削る**ことになる。

> `browser-tester` が `report.md` を書けない件を `allowed-tools` の不備と見て直そうとしたが、
> 実物には**その項目自体が存在しなかった**。追加していれば、
> 現在は全ツールを使えるエージェントを逆に絞っていた。

同様に、**1点の観測から一般化しない**。初回起動の1回だけを見て
「`enabledPlugins` は導入しない」と断定し、後に訂正した例がある。
