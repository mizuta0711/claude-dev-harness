---
name: backlog-sync
description: 残作業台帳（docs/backlog.md）と機能設計書（docs/features/）の食い違いを直す。計画節の行が指す設計書が無い・設計書が計画節に載っていない・完了したのに行が残っている、を検査して直す。push 前のフック（pre-push-backlog-check）が止めたときの出口。「台帳と設計書が合っていない」「backlog を直して」のときに使う。設計書同期台帳（docs/設計書/.doc-sync.md）は対象外で、そちらは sync-check / pre-push-check が扱う。
allowed-tools: "Bash(node:*), Bash(git log:*), Bash(git status:*), Bash(git mv:*), Read, Edit, Grep, Glob"
---

# 残作業台帳と機能設計書の同期

> ⚠️ **「台帳」は2つある。これを取り違えると、直す場所を間違える。**
>
> | 呼び方 | 実体 | 見る仕組み |
> |---|---|---|
> | **残作業台帳** | `docs/backlog.md` | `new-feature` / `plan-milestones` / `complete-feature` / **このスキル** |
> | **設計書同期台帳** | `docs/設計書/.doc-sync.md` | `update-docs` / `sync-check` / `pre-push-check` |
>
> **このスキルは前者だけを扱う。** 後者が合っていないなら `/harness-core:sync-check` へ。

## なぜ要るか

台帳の行を書くのは3箇所で、**すべて手で書く**。

| 書く側 | 何をする |
|---|---|
| `new-feature` | 計画節に1行足す |
| `plan-milestones` | 順序を置く |
| `complete-feature` | 完了した行を消す |

**整合を見る仕組みが1つも無かった。** 実測で乖離が出ている（appcraft・2026-10-10:
計画 #3 が指す設計書が存在しなかった）。

## Step 1: 検査する

```bash
node -e "const m=require('${CLAUDE_PLUGIN_ROOT}/hooks/scripts/backlog-sync.js');console.log(JSON.stringify(m.check(process.cwd()),null,2))"
```

**`applicable: false` が返ったら、そこで終わる。** 検査の対象外である。

| `reason` | 意味 | どうするか |
|---|---|---|
| `docs/backlog.md` が無い | 0.27.0 より前のプロジェクト | **ここでは作らない。** `/harness-core:harness-update` が配る |
| 残作業台帳に計画節が無い | 開発計画層が届いていない | 同上 |

## Step 2: 1件ずつ、どちらが正かを決める

**⚠️ 機械的に片側へ寄せてはいけない。** 検査が言えるのは「食い違っている」ことだけで、
**台帳が間違っているのか設計書が足りないのかは、作業の実態を見ないと決まらない**。

| 検出 | ありうる正解 |
|---|---|
| `missing-dir`（置き場ごと無い） | **置き場と設計書は別の事実である。** 置き場（`docs/features/planned/` 等）は `/harness-core:harness-update` で配られる（H62。0.31.2 より前のテンプレートでは配られていなかった）。**ただしそれだけでは設計書は生えない** —— あわせて `missing-doc` と同じ判断（作るのか・行を消すのか）が要る |
| `missing-doc`（設計書が無い） | ①`plan-milestones` が置いた予定なら**設計書を作る**（`/harness-core:new-feature`） ②取り下げたなら**行を消す** |
| `row-without-doc`（行にパスが無い） | パスを書く。設計書がまだ無いなら作る |
| `doc-without-row`（計画節に無い） | ①進めるなら**行を足す**（**`#` は空欄でよい** —— 番号は `plan-milestones` が分けたときだけ振る） ②着手しないなら **`docs/features/pending/` へ移す**（`git mv`） |
| `completed-still-listed`（完了なのに残っている） | **行を消す**（`complete-feature` が消し忘れたもの）。**✅ を積み上げない** |

**判断材料は git にある。**

```bash
git log --oneline -5 -- docs/features/<該当>.md   # その設計書で何が起きたか
git status --short                                 # 他セッションが触っていないか
```

> **他セッションが同じファイルを触っている最中なら、触らない**（`CLAUDE.md` の運用ルール）。
> その1件だけ飛ばし、**飛ばしたことを報告に書く**。

## Step 3: 直す

- **台帳の行**は `Edit` で直す。**順序＝優先順位**なので、行を足す位置も決めること
- **置き場を変える**なら `git mv`。**台帳のパスの欄も同時に直す**
  （`new-feature` が「着手するときに直下へ `git mv` し、台帳のパスも直す」と指示している操作）
- **完了処理そのもの**（受け入れ基準の確認・`completed/` への移動）は
  **このスキルではやらない**。`/harness-core:complete-feature` が持つ

> ⚠️ **検査が見ているのは作業ツリーの現状**で、push されるコミットの内容ではない。
> **他セッションが台帳を編集中なら、その未コミットの状態で鳴る。**
> `git status --short` で確かめ、**他セッションの変更には触らない**。

## Step 4: 検査し直して報告する

Step 1 をもう一度走らせ、**0件になったことを確かめる**。

報告に必ず含めるもの:

- **1件ずつ、どちらを正としたか（と、その根拠）**
- **飛ばした件とその理由**（他セッションが触っている・判断がユーザー待ち）
- **検査の対象外だった場合は、その理由**（`applicable: false` の `reason`）

> **直せない件を「直した」と報告しない。** 残った件は残ったと書く。
