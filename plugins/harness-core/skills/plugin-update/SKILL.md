---
name: plugin-update
description: このプロジェクトに導入されているハーネスプラグイン（skills / agents / hooks）を最新版へ更新し、更新前後の版を表で報告する。テンプレート層（CLAUDE.md / rules / config）は対象外で、そちらは harness-update が扱う。同梱の plugin-versions.mjs は --skill でスキルの SKILL.md のパスも引ける。
allowed-tools: "Read, Glob, Bash, PowerShell"
---

# プラグイン層の更新

**このスキルが運ぶのは skills / agents / hooks だけ。**
`CLAUDE.md` / `constitution.md` / `.claude/rules/` / `harness.config.json` は**配信経路が別**で、
`/harness-core:harness-update` が扱う（→ Step 5）。

> **なぜスキルにしているか**: `claude plugin update` は**導入時と同じスコープ**を指定しないと
> `not installed at scope user` で失敗する。手で打つと `--scope project` を落として
> 「更新したのに古いまま」になる（実測）。**対象とスコープの特定を機械にやらせる。**

## Step 1: 対象とスコープを確定する

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/plugin-update/scripts/plugin-versions.mjs" --json
```

出力の `targets` が更新対象（`plugin` と `scope` のペア）。**この値をそのまま次で使う。**

- `targets` が空 → 次の1行で報告して終了:
  `このプロジェクトにハーネスプラグインが導入されていません。導入は claude plugin install <名前>@dev-harness --scope project です。`
- `warnings` があれば、報告にそのまま載せる
- **`userScopeDuplicates` が空でない** → Step 4 で必ず報告する（放置すると更新のたびに両方へ当てることになる）

**`version` を「更新前」として控えておく。**

## Step 2: 更新する

`targets` の1件ずつに対して実行する。**スコープを省略しない。**

```bash
claude plugin update <plugin> --scope <scope>
```

- 出力は3通り: `updated from X to Y` / `already at the latest version (X)` / 失敗
- **失敗しても他の対象は続行する**（1本の失敗で全部止めない）
- `already at the latest version` は**正常**。「変更なし」として扱う

> **`already at the latest version` が想定外に出る場合**、ハーネス側で
> **版番号を上げずに push** された可能性がある（中身だけ変えても更新は届かない）。
> その場合は「ハーネス側で版を上げる必要がある」と報告する。

## Step 3: 更新後の版を取る

Step 1 と同じコマンドをもう一度実行し、**更新後の版**を取る。

**CLI の出力を信じず、必ず取り直すこと。** 実際に書き換わったかを確認するのが目的。

## Step 4: 報告

```
## プラグイン更新結果

| プラグイン | スコープ | 更新前 | 更新後 | 結果 |
|-----------|---------|-------|-------|------|
| harness-core@dev-harness | project | 0.6.0 | 0.6.1 | ✅ 更新 |
| harness-nextjs@dev-harness | project | 0.3.1 | 0.3.1 | ⬜ 変更なし |

（1件でも更新があった場合のみ）
⚠️ **Claude Code の再起動が必要です。** プラグインはセッション起動時に読み込まれるため、
このセッションではまだ旧版が動いています。
```

- **1件も更新が無ければ再起動の案内は出さない**（不要な手間をかけさせない）
- `userScopeDuplicates` があれば添える:
  `⚠️ {plugin} は user スコープにも登録があります。更新のたびに両方へ当てる必要が出るため、user 側を削除することを推奨します（claude plugin uninstall {plugin}）。`
- 失敗した対象があれば、コマンドの出力をそのまま載せる

## Step 5: テンプレート層の案内

**更新があった場合のみ**、報告の最後に添える:

```
> このスキルが更新したのは **skills / agents / hooks** です。
> `CLAUDE.md` / `constitution.md` / `.claude/rules/` / `harness.config.json` は配信経路が別で、
> **再起動してから** `/harness-core:harness-update` を実行すると追従できます。
> （再起動前に実行すると、旧版の harness-update が動きます）
```

**このスキルから `harness-update` を続けて呼ばないこと。** 再起動を挟まないと旧版が動く。

## 付録: スキルの `SKILL.md` を引く（`--skill`）

同梱スクリプトは**スキルの手順書のパスを引く**用途にも使える。
**スラッシュコマンドが解決しないクライアント**（VS Code の Claude Code 拡張パネル等）で
「スキルを実行して」と頼まれたときの経路である。

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/plugin-update/scripts/plugin-versions.mjs" --skill harness-update
# → C:\Users\...\.claude\plugins\cache\dev-harness\harness-core\0.6.2\skills\harness-update\SKILL.md
```

- 引くのは**導入済みの版**のキャッシュ。marketplace クローン（HEAD）とはずれうる
- 環境プラグインのスキル（`browser-test` 等）も同じコマンドで引ける
- 見つからない場合は探した場所を標準エラーに出して終了コード 1

**使い方の規定は `CLAUDE.md`「スラッシュコマンドが解決しない環境での実行」にある。**

## やらないこと

- **プラグインの新規導入**（`claude plugin install`）。導入は初回だけの作業で、
  スコープの選択にユーザーの判断が要る
- **アンインストール**。`userScopeDuplicates` の整理も**提案までに留める**
- **テンプレート層の更新**（→ `/harness-core:harness-update`）
- **他プロジェクトの更新**。このスキルは**カレントプロジェクトだけ**を対象にする
