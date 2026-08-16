# claude-dev-harness — 開発ルール

**このファイルは「ハーネス自体を開発するとき」の規律である。**
ハーネスが生成するプロジェクト側の CLAUDE.md（`templates/base/CLAUDE.md`）とは別物なので混同しないこと。

リポジトリの構成・提供物・利用側の手順は [README.md](README.md) にある。ここには複製しない。

## 作業前に読むもの

| 文書 | いつ読むか |
|------|-----------|
| [docs/reference/プラグイン開発手順.md](docs/reference/プラグイン開発手順.md) | プラグイン（`plugins/`）を直すとき。**反映手順・版番号・スコープ** |
| [docs/reference/harness設定契約.md](docs/reference/harness設定契約.md) | `harness.config.json` の契約に触れるとき |
| [docs/reference/permissionsベースライン.md](docs/reference/permissionsベースライン.md) | テンプレートの `permissions` を触るとき。**単純化してはいけない4点がある** |
| [docs/background/](docs/background/) | 「なぜこの設計なのか」で迷ったとき |
| [CHANGELOG.md](CHANGELOG.md) | 変更を入れる前後（**書式の規約が冒頭にある**） |

### 文書をどこに書くか

**`docs/` の4層（guide / reference / diagrams / background）の使い分けは [README.md](README.md) にある。**
ここには**書く側の固有ルール**だけを置く。

- **`docs/` 直下にファイルを置かない。** 4層のどれかに入れる
- **本リポジトリは実装だけを持つ。** 調査・作業指示・レビュー結果・実測記録は
  **ProjectTemplete リポジトリ** に残す。本リポジトリは public であり、
  かつ「今どうなっているか」を引く場所である
- **ただし、記録から導かれた結論が実装の前提になっている場合は、結論だけ残す。**
  例: permissions の実機検証記録は ProjectTemplete へ移したが、
  **「単純化してはいけない4点」は `docs/reference/` に残した**。
  4点を知らずに deny を短く書き直すと、一度起きた事故が再発する

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

> 実際に2回起きた（`b22c887` / `6c68d30`）。2回目は**別セッションの20ファイルを
> 巻き込んだまま push まで到達**した。**文書に書いてあっても守られなかった**ので、
> `.claude/hooks/repo-guard.js` が機械的に止めるようにした（→ §9）。

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

> **2つの版番号の役割は同じではない**（2026-08-16 実測）。
> **配信を決めるのは `plugin.json` の方**で、`marketplace.json` の `plugins[].version` は
> **install 時に黙って無視される**（`claude plugin validate` 自身が
> `At install time, plugin.json wins (calculatePluginVersion precedence)` と言う）。
>
> 実際 0.6.4 は `marketplace.json` が 0.6.3 のまま3プロジェクトへ配信された。
> つまり片側漏れの実害は「**配信が止まる**」ではなく「**カタログの表示が黙って嘘になる**」。
> **止まらないからこそ気づけない。** だから §3 の機械的検査に任せる。

`templates/` 配下は配信経路が別（`/harness-core:harness-update`）なので版番号は関係しない。
**どちらの層を触っているかを最初に見分けること。**

## 3. push 前に必ず検証する

```bash
claude plugin validate . --strict
```

`plugin.json` と `marketplace.json` の版番号不一致は、**目視レビューでは守れない**種類の不整合である
（実害がすぐ出ないため放置されやすい）。機械的検査に任せる。

`--strict` は warning もエラー扱いにする。push 前のチェックはこちらを使う。

**これは覚えておく規律ではない。`.claude/hooks/repo-guard.js` が `git push` を捕まえて実行し、
失敗したら deny する**（→ §9）。

## 4. 判定ロジックは `tests/` で守る

```bash
node --test "tests/*.test.mjs"
```

実体は Node スクリプト群で、**判定の中心は正規表現とファイル分類＝純関数**である。
`claude plugin validate --strict` は**マニフェストの整合しか見ない**ので、
ロジックはこちらで検査する。**依存パッケージは使わない**（`node:test` と `node:assert` だけ）。

- **CHANGELOG に「〜ケースで確認した」と書くなら、同じものを `tests/` に置く。**
  置かなければ、次に判定式を触った人はそのケースを守れない
- テストのために本体へ `export` を足すのは可。ただし**実行部は
  `require.main === module`（CJS）/ `import.meta.url` 比較（ESM）で囲う**こと
  （囲わないと `require` した瞬間に stdin を読みに行って固まる）
- **失敗したケースを消さない。** 直したら期待値を変える（回帰の記録になる）

詳細は [tests/README.md](tests/README.md)。CI（`.github/workflows/ci.yml`）が
Linux と Windows の両方で回す。

## 5. CHANGELOG は省略しない

変更を入れたら [CHANGELOG.md](CHANGELOG.md) に追記する。**書式の規約は同ファイルの冒頭**にある。

特に各エントリ末尾の **`docs 影響: あり（対象） / なし`** の1行を落とさないこと。
`docs/diagrams/` と `docs/guide/` は自動同期の対象外で、**申告しなければ必ず乖離する**。

## 6. 気づいてもその場で直さない

改善に気づいても**その場では直さず、記録して区切りでまとめて対応する**
（`templates/base/constitution.md` §8 と同じ規律をこのリポジトリにも適用する）。

- 開発の流れを止めないため
- **まとめて直す方が質が上がる。** 1件ずつ直すと場当たりの分岐が増えるが、
  複数件を並べると共通の原因が見えて、より根本的な直し方が選べる

## 7. ファイルの約束

- 全ファイル UTF-8（BOM 無し）・改行 LF（`.gitattributes` で固定）
- **例外: `.ps1` は UTF-8 BOM 付き**。Windows PowerShell 5.1 は BOM 無し UTF-8 を
  CP932 と誤読して日本語が化けるため、BOM が唯一の判別材料になる
- **`templates/` に業務固有名・実プロジェクト由来の固有値を入れない**（本リポジトリは public）
- hooks はすべて Node.js（CommonJS）。PowerShell / Bash スクリプトは使わない
  （Windows・コンテナ両対応のため）

## 8. 直す前に原因を確定する

**推測で直さない。** 想定した原因と実物が食い違うことは実際に起きており、
そのまま直すと**改善のつもりで機能を削る**ことになる。

> `browser-tester` が `report.md` を書けない件を `allowed-tools` の不備と見て直そうとしたが、
> 実物には**その項目自体が存在しなかった**。追加していれば、
> 現在は全ツールを使えるエージェントを逆に絞っていた。

同様に、**1点の観測から一般化しない**。初回起動の1回だけを見て
「`enabledPlugins` は導入しない」と断定し、後に訂正した例がある。

## 9. このリポジトリ自身の `.claude/`（H19）

**ハーネスはハーネスの利用者である。** 以前このリポジトリには `.claude/` が無く、
規律は本ファイルという**読ませる文書だけ**で担保されていた。
結果、2026-08-16 の1日で §1・§2・§5 の違反が3件（うち §2 は2版連続）出た。

| ファイル | 役割 |
|---------|------|
| `.claude/settings.json` | PreToolUse に `repo-guard.js` を登録 |
| `.claude/hooks/repo-guard.js` | 下表のとおり止める／知らせる |

| 対象 | 扱い |
|------|------|
| `git add -A` / `.` / `--all` / `:/` | **deny**（§1） |
| `git commit -a` / `-am` / `--all` | **deny**。追跡済みを全部巻き込むので**実害は `add -A` とほぼ同じ** |
| `git stash`（退避する形。`list` / `show` / `pop` / `apply` / `drop` は通す） | **deny** |
| `git checkout -- .` / `git restore .` / パス指定なしの `git clean` | **deny**（`git clean -n` は通す） |
| **パス指定なしの `git commit -m`** | **警告のみ。** 正当な使い方があるため止めない |
| `git push` 前の `claude plugin validate . --strict` | **deny**（§2・§3）。`claude` が無い場合は**そう言う**（版番号のせいにしない） |

**同じ判定を2箇所が持つ。片方だけ直さないこと。**

| 置き場 | 効く範囲 |
|--------|---------|
| `claude-dev-harness/.claude/` | このリポジトリを直接開いたセッション |
| `ProjectTemplete/.claude/` | **還元作業のセッション**（同一内容のコピー） |
| `plugins/harness-core/hooks/scripts/git-scope.js` | **利用側プロジェクトへ配る**判定（`pre-commit-scope`） |

`tests/git-scope.test.mjs` が乖離を検出する。

> **設計の理由（なぜ配布物のプラグインに置かないのか／なぜ置き場所が1箇所では足りないのか／
> なぜ判定をコマンド位置に限るのか）は [`.claude/hooks/repo-guard.js`](.claude/hooks/repo-guard.js) の
> 冒頭コメントにある。** ソースの隣に置くのがこのリポジトリの流儀なので、ここには複製しない。

> **フックは編集した瞬間には効かない。** セッション開始時に読み込まれるため、
> `repo-guard.js` を直したら **Claude Code を再起動する**こと。
