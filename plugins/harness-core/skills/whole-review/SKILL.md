---
name: whole-review
description: アプリ全体（全ソース）の査読。変更差分ではなくソース全体を whole-reviewer（model inherit＝セッションのモデル）に読ませ、変更単位のレビューでは拾えない横断の欠陥を所見として返す。修正はせず、出口は設計書への起こし候補の一覧。「全体を査読して」「アプリ全体をレビューして」の入口。SessionStart / pre-push-check / complete-feature が「全体査読の目安に達した」と催促したときにも使う。--mark で査読せずに記録だけ、--snooze で見送り。
argument-hint: "[--mark [レビュー記録のパス] | --snooze | （省略＝査読を回す）]"
allowed-tools: "Bash(node:*), Bash(git log:*), Bash(git rev-parse:*), Bash(git ls-files:*), Grep, Glob, Read, Write, Edit"
---

# 全体査読

変更単位のレビュー（`design-review` / `code-review`）は、**変更と変更の間に生まれる非対称**を原理的に拾えない。
このスキルは**全ソース**を `whole-reviewer` に読ませ、横断の欠陥を所見として返す。**修正はしない。**

> **契機はこのスキルの外にある。** `.claude/harness.config.json` の `wholeReview.nudge` の閾値
> （前回の全体査読からの完了本数・src の差分行数・コミット数）に達すると、
> SessionStart・`/harness-core:pre-push-check`・`/harness-core:complete-feature` が**催促する**。
> **自動では回さない** —— 全ソースを読むコストはユーザーが決める。催促に「回して」と返せばここに来る。

## Step 0: 引数で分岐

| 引数 | すること |
|------|---------|
| `--mark [パス]` | **査読せずに HEAD を記録する。** 手で全体査読を回した直後のプロジェクト向け（記録が無いと「一度も回していない」として催促が続く）。`node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/whole-review-nudge.js" --mark <パス>` を実行して終わる |
| `--snooze` | **今回は見送る。** `node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/whole-review-nudge.js" --snooze` を実行して終わる（HEAD から再び閾値ぶん溜まるまで催促が黙る） |
| （省略） | Step 1 へ |

## Step 1: 範囲と突き合わせ先を決める

1. `.claude/harness.config.json` を読み、`paths.source`・`designDocs.docs[]`・`projectDocs.policy` を取る（config が無ければ `src/` と `docs/設計書/` を推定し、推定したことを報告に書く）
2. `git ls-files -- <paths.source>` で対象ファイルを列挙し、**層ごとの本数**を把握する（読む順を決める材料）
3. 前回の記録 `.claude/.whole-review.json` を読む（無ければ「初回」）
4. **既知の項目**を集める: `docs/backlog.md` の残作業の表と、`docs/features/planned/` の設計書の題名

## Step 2: `whole-reviewer` を起動する

```
Agent(subagent_type: "whole-reviewer", prompt:
  "アプリ全体の査読。対象: {paths.source の列挙} と {永続化の置き場}（コミット {HEAD}）。
   突き合わせ先: constitution.md / {designDocs.docs[] のパス} / {projectDocs.policy のパス}。
   既知の項目（当たる所見には【既知 #n】を付けて）: {Step 1-4 の一覧}。
   前回の全体査読: {lastCommit・date、または初回}。
   読んだ範囲と読まなかった範囲を表で明示し、所見ごとに根拠の行を引用して。修正はしないで。
   出力はエージェント定義の構成（1 読んだ範囲 / 2 所見 / 3 良い点 / 4 起こし候補）で返して。")
```

- **モデルはエージェント定義の `model: inherit`**。このセッションのモデルで走る。**起動側で上書きしない**
- `Task` の並列分割はしない（1 本で全体を読む。読み切れない範囲は「読まなかった」として返ってくる）

## Step 3: 記録して、起こし候補を出す

1. 返ってきた本文を `docs/reviews/YYYYMMDD_HHMMSS_whole-review.md` に保存する（冒頭に実施日時・対象コミット・使ったモデル）
2. **所見を 1 件も自動修正しない**（`code-review` の Step 5 に当たるものは持たない）
3. 「4. 設計書への起こし候補」を**ユーザーに一覧で見せる**（候補ごとに含む所見・規模の推測・理由）。
   既知（【既知 #n】）は候補に入れず、「既知の項目と一致: n 件」と別に出す
4. **ユーザーが選んだ候補**を `/harness-core:new-feature <候補名>` に渡す（着手前なら `docs/features/planned/` へ。台帳の計画節に順序が置かれる）。
   選ばれなかった候補は記録に残る（次回の【既知】照合の対象になる）
5. 記録を書く: `node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/whole-review-nudge.js" --mark docs/reviews/YYYYMMDD_HHMMSS_whole-review.md`

## Step 4: 報告

```
## 全体査読

- 記録: docs/reviews/YYYYMMDD_HHMMSS_whole-review.md（モデル: …・対象 {HEAD}）
- 読んだ範囲: … / 読まなかった範囲: …
- 所見: 高 n・中 n・低 n（既知と一致 n・要再現 n）
- 起こし候補: n 件（選択待ち） → 選んだもの: …（new-feature へ）
- 前回の候補で未着手のもの: n 本（台帳の計画節の行）
```

**「前回の候補で未着手のもの」を必ず出す。** 入口だけ回すと未着手が積もる。
出口は台帳の計画節（順序＝優先順位）が持っていて、新しい仕組みは作らない。
