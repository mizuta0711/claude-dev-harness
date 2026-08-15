# 設計方針（`.claude/01_development_docs/` `02_design_system/` `00_project/`）

このディレクトリ群は、**このプロジェクトが「これから何に従うか」**を書く場所である。
`harness-update` の追従対象外（この README を除く）で、**中身はプロジェクトが育てる**。

## 何をどこに書くか

| 置き場 | 書くもの | 読まれる場面 |
|--------|---------|-------------|
| `00_project/` | **要件・ドメイン知識**（アプリ要件、ビジネスルール、ドメイン固有の用語と制約） | **Stage 1（機能・画面設計）** |
| `01_development_docs/` | **設計方針**（層構成・依存方向・命名・エラー処理方式・型定義方針・各層の設計） | **Stage 2（技術設計）** |
| `02_design_system/` | **デザイン方針**（カラー・タイポグラフィ・コンポーネント設計指針） | Stage 1 / Stage 2 |

書いたら **`.claude/harness.config.json` の `projectDocs` に登録する**（登録しないとスキルが読まない）:

```json
"projectDocs": {
  "requirements": [".claude/00_project"],
  "policy": [".claude/01_development_docs", ".claude/02_design_system"]
}
```

## 4つの運用ルール

1. **Stage 1 は `requirements`、Stage 2 は `policy` を読む。** 設計時に必ず参照する
2. **設計判断が確定したらここへ書き戻す。** CLAUDE.md や個別の機能設計書に散らさない
   （機能設計書の「書き戻し先」欄に、どのファイルへ反映するかを書いてから実装する）
3. **「今こうなっている」は書かない。** それは `docs/設計書/` の職掌。
   ここに書くのは**「これから何に従うか」と「なぜそうするか」**
4. **開発フロー・規模判定は書かない。** ハーネスの職掌
   （`constitution.md` §1〜§5 と `/harness-core:new-feature` が持つ）

> **書く場所の見分け方**
> - 言語・フレームワークの規約で、**同じ環境の別プロジェクトにもそのまま貼れる** → `.claude/rules/`（ハーネスが配る）
> - **このプロジェクトでしか通用しない** → ここ
> - **今の実装がどうなっているか** → `docs/設計書/`

## 腐らせないための定期点検

ルール3（実態を書かない）は**破られていても気づきにくい**。一覧や表を書いた時点では正しいため、
実装が進んで初めて嘘になる。次の方法で年に数回、あるいは大きな機能を入れた後に点検する。

**1. 文書が主張している「数」と実装の数を突き合わせる。** 乖離が大きいほど、それは方針ではなく実態である:

```bash
grep -c "^model " prisma/schema.prisma           # テーブル数（nextjs）
find src/app/api -name route.ts | wc -l          # エンドポイント数
find src/app -name "page.tsx" | wc -l            # ページ数
```

**2. 改訂履歴の最終日付を見る。** 実装が動いているのに文書が数ヶ月止まっていれば、
**誰も更新していない ＝ ここが正本ではない**。

**3. 見つかったら移す。** 実態は `docs/設計書/` へ移し、**`harness.config.json` の
`designDocs` と `docTriggers` に登録して自動同期の対象にする**。登録しなければまた腐る。

> **放置したときの実害（実測）**: API 設計書が `docs/設計書/API一覧.md` と二重管理になっていた
> プロジェクトでは、**設計レビューが「存在しない義務」を3回にわたって指摘していた**
> （いずれも `API一覧.md` 側では同期済み）。レビュー工数がまるごと無駄になる。

**節単位で混在することがある。** ファイルごと消さず、節だけ削る判断もする
（例: architecture 設計書の「レガシーコード削除計画」節だけ削り、層構成・依存方向・命名規則は残す）。
**完了済みの計画を消すときは、本当に完了しているかコードで確認してから消すこと。**

## 必要になった時点でファイルを起こす

**最初から全部作らない。** 空のまま放置されたファイルは読まれず、あるだけ邪魔になる。
実際に「毎回これを思い出す必要がある」と気づいた時に作る。

以下は実プロジェクトの実績から抽出した**推奨軸**。この通りの名前・粒度である必要はない。

### 共通（`00_project/`）

| ファイル | 中身 |
|---|---|
| `app_requirements.md` | プロダクト概要・コアコンセプト・主要機能・成功指標 |
| `domain_rules.md` | ドメイン固有の用語・制約・「この機能を扱う時だけ知っていればよい」ルール |

### Next.js（`01_development_docs/`）

`01_architecture_design.md`（同梱）に加えて:
`02_database_design` / `03_api_design` / `04_error_handling_design` / `05_type_definitions` /
`06_service_repository_design` / `07_hooks_design` / `08_ai_prompt_design` / `debugging_guidelines`

`02_design_system/`: `design_system_overview` / `component_library` / `color_system` / `typography` / `icon_system`

### WPF（`01_development_docs/`）

`01_architecture_design.md`（同梱）に加えて:
`02_persistence_design`（永続化フォーマットとバージョン移行）/ `03_transport_protocol_design`（通信・状態遷移）/
`04_error_handling_design` / `05_type_definitions` / `06_services_design` / `07_viewmodel_binding_design` /
`scripting_design`（動的コード実行を持つ場合）

`02_design_system/`: `design_system_overview` / `component_library`

### Unity（`01_development_docs/`）

`01_app_architecture.md`（同梱）**1本で足りることが多い**。
レイヤー構造・依存の原則・当たり判定の方針・ScriptableObject 設計方針・命名規則・
「着手前に合意が必要な設計判断」をここにまとめる。

## 書式

- 各ファイルの末尾に**改訂履歴**（版数・日付・内容）を置く
- 実装と食い違いが出たら**どちらが正か決めてから**直す（黙って合わせない）
- 汎用的だと分かった規約は `.claude/rules/` へ昇格させ、ハーネスへ還元する（`constitution.md` §8）
