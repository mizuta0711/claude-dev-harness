# CHANGELOG

このリポジトリの変更履歴。バージョンは各プラグインの semver を指す。
経緯・設計判断の詳細は ProjectTemplete リポジトリの `docs/` と `docs/reviews/` にある。

## 書式

各エントリの末尾に **`docs 影響: あり（対象） / なし`** を1行書く。

`docs/diagrams/` と `docs/guide/` は `update-docs` / `sync-check` の対象外（あれはプロジェクトの設計書向け）で、
**放置すれば必ず実装と乖離する**。乖離を機械では検出しないため、変更時に自分で申告する運用にしている。

```
docs 影響: あり（guide/セットアップガイド.md — 導入手順が変わるため）
docs 影響: なし
```

「あり」と書いたものは、その版を push する前に更新して**各文書冒頭の「対応ハーネス版」を上げる**。

## [Unreleased] — 移行時の棚卸しに独立査読ゲートを新設（docs のみ）

ユーザー指示: **「メインエージェントだけで作業を完了させると、誤った判断をおこなっていることに
気づけない」**。1.4 までは「別のエージェントに独立検証させると効果が高い」という**助言**が
§3-5 の本文にあるだけで、**工程になっていないため素通りできた**。

### Added
- **`guide/既存プロジェクト移行指示書.md` §3-6「棚卸しは別エージェントの査読を通してから確定する」**（必須ゲート）
  - **査読は2回**: 削除を実行する前（計画の査読）と、実施した後・コミットの前（作業の査読）
  - **同一会話の続きでやらない。** サブエージェント（`code-reviewer`）か別セッション。
    同一文脈の自己レビューは**自分の判断を追認するだけ**になる
  - **査読者に結論を渡さない。** 「対象と根拠」までを渡して判断させる。依頼テンプレートを同梱
  - 指摘は `docs/reviews/YYYYMMDD_設計方針層の棚卸し.md` へ。
    メインは全指摘に**「対応済み / 見送り（理由）」を明記**する
  - **査読結果自体も誤りうる**ことを明記（skillup_mock で実際に1件あった）。
    査読は「正解を出す工程」ではなく「**メインが気づけない範囲を広げる工程**」
  - 根拠として skillup_mock の実測（独立レビュー7件 / メインの自己点検 0件）を併記
- §0 大原則に **「削除判断はメイン1本で確定させない」** を追加
- §3 の仕分け対象表に **`.claude/` 直下の単独ファイル**の行を追加。
  EngineerPotal の `.claude/browser-test-checklist.md` で発見。プラグイン同梱版と内容一致だったが、
  **表に行が無いと照合そのものが行われない**

docs 影響: あり（guide/既存プロジェクト移行指示書.md — 1.5 として本エントリで更新済み）

## [Unreleased] — 開発フロー図に完了処理を追加（docs のみ）

前エントリで「未解消として記録」した欠落への対応。

### Fixed
- **`diagrams/02_開発フロー図.md` に `complete-feature` が登場していなかった。**
  実装 → code-review → 動作確認 → build-check → update-docs → コミット、で図が終わっており、
  **M / L フローの完了処理がまるごと抜けていた**（本件以前からの欠落）
  - **★ゲート5（完了処理）を追加**し、「4つのゲート」→「5つのゲート」に改めた
  - **コミット → タスク残判定 → 実装のループを明示。** 実装からコミットまでは1周ではなく、
    設計書のタスクが残る限り回る（図が1本線に見えて誤読しやすい箇所だった）
  - ゲート5 が見る3つ（タスク一覧 / 受け入れ基準 / **設計方針への書き戻し**）を表で追加。
    いずれも「理由を書いて対象外にする」ことはできるが**黙って消すことはできない**
  - S 規模はゲート5 を通らない（設計書を持たないため）ことを経路として明示
  - 「人が介在しない唯一のゲート」という記述がゲート5 と矛盾するため、
    **「Claude の判断を介さない唯一のゲート」**（ランタイムが実行する）へ精密化
  - 対応ハーネス版を 0.3.0 系 → 0.6.0 系へ更新。`05_フック発火タイミング図` への
    「別図で扱う予定」というリンク切れも解消

docs 影響: あり（diagrams/02_開発フロー図.md — 本エントリで更新済み）

## [Unreleased] — docs 全点検（版番号ヘッダの是正と反映漏れ）

`docs/` 配下15本を再点検した。**版番号ヘッダの更新を怠っていた**（本 CHANGELOG 冒頭の
「docs 影響ありと書いたものは対応ハーネス版を上げる」という自分のルール違反）。

### Fixed
- **6本の「対応ハーネス版」を 0.6.0 系へ更新** — セットアップガイド / 運用ガイド /
  diagrams 01・03・04・06。いずれも設計方針層の導入で内容を更新済みだったのにヘッダが 0.5.0 / 0.3.0 のままだった

### Changed
- **`background/02_SpecKitとの差異.md`** — ライフサイクル比較表に
  **「設計方針の蓄積」「要件・ドメイン知識」の2行を追加**。SpecKit 側は機能ごとの `plan.md` に閉じ、
  **横断する設計判断の置き場が無い**のに対し、ハーネスは `projectDocs` で層を持ち
  Stage 2 の整合検査と `complete-feature` の書き戻し強制まで繋がっている。
  「完了」行にも書き戻しゲートを追記
- **`guide/入門ガイド.md` に §5-5「『今後も従う決定』は機能設計書に置いたままにしない」** —
  初学者向けに、設計方針層の役割と「実態は `docs/設計書/` の職掌」の境界を1節で説明
- **`guide/運用ガイド.md`** — `complete-feature` の説明に書き戻しゲートを追記。
  §1-2 に **0.5.0 → 0.6.0 の追従実測**（設計方針層の中身は何千行あっても競合に出てこない /
  見送った差分は再提案されない / テンプレートは既定であって強制ではない）を追加

### 点検して「更新不要」と判定したもの

`diagrams/02_開発フロー図`（4ゲートの構造は不変）/ `diagrams/05_フック発火タイミング図`
（`projectDocs` はフックの関心事ではない）/ `guide/オプションMCP追加ガイド` / `permissions-baseline`
（スキルの frontmatter は対象外）/ `backlog-phase0-findings`（Phase 0 時点の記録）。

> **未解消として記録**: `diagrams/02_開発フロー図` に `complete-feature` が登場しない。
> 本件以前からの欠落であり、今回の変更とは独立した課題。

docs 影響: あり（本エントリの対象6本 + background/02 + guide/入門ガイド + guide/運用ガイド — 更新済み）

## [Unreleased] — 棚卸しの独立レビュー還元（移行指示書 1.4 + rules 2本）

利用側の棚卸しを**別エージェント2体に独立検証**させた結果、削除の判断そのものは支持されたが
**手順に3種類の穴**が見つかった。出典: `skillup_mock/docs/reviews/20260815_設計方針層の棚卸し.md`

### Added
- **移行指示書 §3-5 に「削除前チェック」3項目** — 「正本が別にある」だけでは削除の理由にならない
  1. **正本の方が実装と乖離していないか。** 実測では通知 API で**正本の方が間違っていた**
     （一覧キーが `notifications`。実装と削除対象はどちらも `items` で、正本は `rules/api.md` の規約にも違反）
  2. **正本に無い契約が消えないか。** 正本の API一覧はパス・メソッド・説明の3列だけで、
     **削除対象だけがリクエスト/レスポンスの契約を持っていた**
  3. **参照元の grep。** `docs/features/pending/` は**未着手＝アクティブ文書**であり、
     `completed/`（過去記録・リンク切れ許容）とは扱いが違う
- **同 §3-5 に「残す側も点検する」** — 実測では**削除した文書の方が訂正済み**で、
  **正確な文書を消して不正確な文書を残していた**
- **同 §3-5 に「移設・新規記述は実装で裏を取る」** — 移設先の新規記述に読み違いが3件
  （うち1件は移設元からの無検証転記）。**別エージェントによる独立検証**を推奨
- **同 §3-5 に「自動生成されるファイルに手書きで足さない」**
- **`templates/nextjs/.claude/rules/prisma.md` に補足情報の置き場** —
  `docs/設計書/テーブル定義書.md` は `generate-table-docs.ts` が **`fs.writeFileSync` で全文上書き**するため、
  手書き補注は次回生成時に**無言で消える**。`schema.prisma` の `///` コメントが**唯一の永続的な置き場**

### Changed
- **`templates/base/.claude/01_development_docs/README.md` の推奨軸メニューに警告を追加** —
  `designDocs` に同じ軸がある場合、ここに書けるのは「なぜそうするか」だけ。
  **実測では `02_database_design` / `03_api_design` / `05_type_definitions` /
  `06_service_repository_design` / `07_hooks_design` / `08_ai_prompt_design` の6本すべてが
  実態スナップショットに退化して削除された** — メニューが罠へ誘導していた

docs 影響: あり（guide/既存プロジェクト移行指示書.md — 本エントリで更新済み）

## [Unreleased] — 設計方針層の棚卸し手順（移行指示書 1.3 + テンプレ README）

利用側（skillup_mock）で実施された棚卸しの実測を還元する。
出典: `skillup_mock/docs/reviews/20260815_設計方針層の棚卸し.md`

### Added
- **移行指示書 §3-5「設計方針層の棚卸し（実態スナップショットの摘出）」** —
  旧テンプレート由来の設計文書には「今こうなっているか」の記述が混ざっており、**残すと腐る**。
  検出手順（**文書が主張する数と実装の数を突き合わせる** / 改訂履歴の停滞を見る）、
  1本ずつの分類基準（実態 / 方針 / 完了済みの過渡期メモ）、**節単位で削る判断**、
  そして**移行とは別作業として実施する**運用を記載
- **`templates/base/.claude/01_development_docs/README.md` に「腐らせないための定期点検」** —
  同じ検出手順を、新規プロジェクトにも最初から配る

### Changed
- **移行指示書 §3-4 を「残置が既定」から「解体する」へ変更** — `03_library_docs/` の中身を
  規約（rules）/ 実態（docs/設計書）/ 版固有の罠（CLAUDE.md）の3つに割り、**層ごと廃止する**
- **1.2 で書いた「`03_library_docs` を `projectDocs.policy` に登録する」を撤回。**
  設計方針層の3分類に属さない層を `policy` に入れると、**Stage 2 のたびに古い実態スナップショットを
  読ませることになる**（skillup_mock では解体後に残ったのが実態1本だけだった）

> **実害の実測**: API 設計書が `docs/設計書/API一覧.md` と二重管理になっていたプロジェクトでは、
> **設計レビューが「存在しない義務」を3回にわたって指摘していた**（いずれも API一覧.md 側では同期済み）。

docs 影響: あり（guide/既存プロジェクト移行指示書.md — 本エントリで更新済み）

## [Unreleased] — 移行指示書 1.2（フェーズ2-0/2-1 の実測還元・docs のみ）

### Changed
- **`guide/既存プロジェクト移行指示書.md` 1.2**
  - **§3-1 に `.gitattributes` の確認手順を追加** — CRLF による誤判定の**根本原因**がこれだった
    （skillup_mock の追い直しで判明）。無いと blob 照合だけでなく**以後の `harness-update` の
    3点比較でも全ファイルが差分として出る**。`git ls-files --eol` で index が LF なら
    追加しても再正規化が起きないことも併記した
  - §4 の移植表に `.gitattributes` / 設計方針層の README / `tools/README.md` / `.devcontainer/` を追加。
    **プロジェクト側が育っているものはそちらを優先する**旨も明記
  - §5 に `03_library_docs` を `policy` へ登録する指針と、**パスの実在チェック**を追加
  - 実測の記録に**追い直し2本**（bookmark-app / skillup_mock）の分類結果を追加。
    「既存の設計方針文書は追従対象外」「見送った差分は再提案されない」
    「テンプレートは既定であって強制ではない」の3点を運用注記として記録

docs 影響: あり（guide/既存プロジェクト移行指示書.md — 本エントリで更新済み）

## [Unreleased] — フェーズ2-0 の実測反映（テンプレート層のみ・版番号なし）

### Fixed
- **nextjs `react-nextjs.md` の「ストアの利用」節** — `state-management.md` を無条件に参照していたため、
  **ストアライブラリを使わないプロジェクトで参照先が存在しない状態**になっていた（bookmark-app の
  `harness-update` で実地に発生。実行したエージェントがローカルで文面を調整して回避した）。
  「使っている場合のみ適用」と明示し、参照先が配置されない場合がある旨を追記した。
  wpf の3本（mvvm-viewmodel / csharp-wpf / xaml-ui）は常に同時配布されるため同種の問題は無い（確認済み）

docs 影響: なし

## [0.6.0] harness-core / [0.3.0] harness-nextjs / [0.2.0] harness-wpf — 設計方針層の復活と②規約の回収

統合時に脱落していた**設計方針層**を戻し、`03_library_docs/` から `.claude/rules/` への移設で
痩せていた**環境共通の規約**を回収する。経緯は ProjectTemplete `docs/14_設計方針層_調査と導入計画.md`。

> **背景（2件のリグレッション）**: 旧3テンプレートは全て `.claude/01_development_docs/` 等の
> 設計方針スケルトンを配っていたが、プラグイン化の際に**テンプレート層から丸ごと欠落**していた。
> また `03_library_docs/` は「汎用ガイドは不要」として落としたものの、その中の**規約**は
> 移設先の rules に十分書かれておらず、実質的に失われていた（wpf 576行→109行 / nextjs 325行→148行）。

### harness-core 0.6.0

#### Added
- **`projectDocs` 設定キー**（`requirements` / `policy`）— プロジェクトが育てる文書の場所を宣言する。
  `designDocs`（＝実装の**現況**）とは別物で、こちらは「**これから何に従うか**」。
  **未登録・空なら素通り**（fail-open）。`schemaVersion` は 1 のまま
- **`new-feature` Step 2 に要件文書の参照**を追加 — Stage 1 の前に `projectDocs.requirements` を読み、
  依頼内容と矛盾するドメイン制約が無いかを確認する
- **`TEMPLATE.md` に §4-0「設計方針への書き戻し」**を追加 — Stage 2 で決めた「今後も従う設計判断」の
  行き先を書く欄。ここが無いと決定が機能設計書に埋もれる
- **`complete-feature` にゲート3（書き戻し確認）**を追加 — §4-0 に未反映が残っていたら完了を止める。
  併せて `allowed-tools` に `Write` を追加（メニューから新規ファイルを起こせなかったため）
- **`design-review` が `projectDocs` を読む** — `feature` は requirements、`tech` は policy と突き合わせ、
  **Stage 2 が既存方針に反していないか**を検査する

#### Changed
- **`harness-update` が設計方針層を追従対象外にする**（`harness-diff.mjs` の `NEVER_TOUCH`）。
  `.claude/01_development_docs/`（**`README.md` を除く**）/ `02_design_system/` / `00_project/` が対象。
  除外しなければ、既存の大規模プロジェクト（6,500行級）で**差分が全て競合**になり finalize がブロックされる

### templates（版番号なし）

#### Added
- **`base/.claude/01_development_docs/README.md`** — 設計方針層の運用ルールと**環境別の推奨軸メニュー**。
  「必要になった時点でファイルを起こす」方式（空スケルトンの大量配布はしない）
- **環境別の architecture 骨格** — nextjs/wpf は `01_architecture_design.md`、
  **unity は `01_app_architecture.md`**（既存プロジェクトと rules の参照に合わせた別名）。
  `create-project.mjs` は md をマージせず env が base を上書きするため、**base には置かない**
- **`templates/nextjs/.devcontainer/devcontainer.json`** — 旧テンプレートにあり統合時に落ちていた。
  `bypassPermissions` はコンテナ隔離を前提とした設定であり、**前提が崩れる使い方をする場合は削除する**旨を明記
- `templates/nextjs/tools/README.md` / `tests/browser-evidence/.gitkeep` — 同じく取りこぼしの復帰

#### Changed（②の規約を rules へ回収 — **埋めてから消す**）
- **wpf `mvvm-viewmodel.md`**（37行 → 約140行）— `partial class` 必須（**忘れるとビルドが通らない**）/
  `[ObservableProperty]` の命名規則と変更フック / `CanExecute` + `NotifyCanExecuteChanged` の定石 /
  **非同期コマンド一式**（`IAsyncRelayCommand` / `CancellationToken` 自動供給 / 再入防止）/
  **例外は ViewModel でログ化・Core ではキャッチしない** / Messenger / チェックリスト
- **wpf `csharp-wpf.md`**（46行 → 約140行）— 非同期とスレッド（`.Result`/`.Wait()` 禁止 /
  `ConfigureAwait` の判断基準 / Dispatcher の使い分け / `PeriodicTimer` / **冪等な停止パターン**）と、
  **動的コード実行・プラグインのセキュリティ方針7項目**（64行 → 3行に圧縮されていたものを復元）
- **wpf `xaml-ui.md`（新規）** — バインディング規約 / リソースとスタイル / ModernWpfUI セットアップ /
  **デザイントークン**（セマンティックカラー・4px スペーシング・タイポグラフィ）/ IValueConverter /
  再利用コンポーネント / よくある落とし穴。
  **`ResourceDictionary.ThemeDictionaries` は WPF ではビルドエラー（MC3074）**、
  **コンバータでブラシを `Freeze()`・キャッシュするとテーマ切替に追従しない**という2つのハマりどころを含む
- **nextjs `state-management.md`（新規）** — Zustand の設計原則 / **ストアに入れるものと入れないものの判断基準** /
  永続化の判断 / セレクターによる再レンダリング抑制 / ハイドレーション不一致。
  移設時に rules へ**一切残っていなかった**もの
- **nextjs `api.md`** — レスポンス形式の既定 / **ページネーションキーは `items` に統一** /
  認証と **`userId` スコープ** / **N+1 クエリを作らない**（旧 `review-impl` の観点。改名時に落ちていた）
- **nextjs `react-nextjs.md`** — レスポンシブの確認幅（**375px / 1280px**）/
  インライン `style={{ width }}` の幅超過 / ストア利用時の注意

#### Changed（波及）
- `base/CLAUDE.md` のドキュメント構成表と肥大化防止の記述、`base/constitution.md` §4・§8 に設計方針層を追加
- `docs/harness-config-contract.md` に **§8 `projectDocs`** を新設（`designDocs` との違いの対比表つき）
- `docs/background/01_統合前後の差異.md` の Before/After 図に**欠落していた層**を明記し、修復内容を追記
- `docs/diagrams/` 01（全体アーキテクチャ）/ 03（役割比較）/ 04（スキル実行シーケンス）/ 06（改善還元フロー）を更新。
  06 には**③→② の昇格**（プロジェクトの設計方針が汎用と分かったら rules へ還元する）を追加
- `guide/既存プロジェクト移行指示書.md` 1.1 — §3 の仕分け対象に `.claude/` 直下の文書群を追加。
  **開発フロー文書は番号でなく中身で特定して削除し、CLAUDE.md の参照を張り替える**（番号は実プロジェクトで
  振り直されており、CommSim では 08 が別ファイル）。§5 に `projectDocs` 登録、§8-2 に
  **プロジェクト側 `TEMPLATE.md` への「書き戻し先」欄の追加**（同梱版を直しても届かないため）

docs 影響: あり（harness-config-contract.md / guide/セットアップガイド.md / guide/運用ガイド.md /
guide/既存プロジェクト移行指示書.md / background/01 / diagrams 01・03・04・06 / README.md / plugin-development.md
— いずれも本エントリで更新済み）

## [Unreleased] — 既存プロジェクトの移行（C4 の実測1本目）

### docs（版番号なし）

#### Added
- **`guide/既存プロジェクト移行指示書.md`** — 旧テンプレート由来の既存プロジェクトを
  統合ハーネスへ移すための**エージェントへ渡す手順書**。`skillup_mock`（nextjs）で
  1本通した実績にもとづき、**実際に効いた手順と踏んだ落とし穴だけ**を書いた
  - **ローカル資産の仕分けを blob ハッシュで判定する**手順（旧テンプレの履歴に一致があるか）。
    最新版との単純 diff では「テンプレートが進化しただけ」と区別できない
  - **改行コード（CRLF/LF）を正規化してから比較する。** 忘れると全ファイルが「改変あり」になる
  - **「改変あり」の正体はドキュメントパスの埋め込み**だった。捨てずに `harness.config.json` の
    `designDocs` と `.claude/rules/` へ**移送する**
  - **`harness-baseline.json` を移行時に必ず書く**（無いと以後の `harness-update` が全部競合になる）
  - `settings.json` の `hooks` ブロック削除（プラグインと二重に走る）
  - 検証で出た失敗を**移行由来かどうか切り分ける**（実測では `prisma generate` と `npm install` 漏れで、
    いずれも移行とは無関係だった）

#### Changed
- `guide/セットアップガイド.md` §7 の**「未実測」を解除**し、移行指示書へ誘導する形にした。
  未実測なのは unity / wpf 環境のみ
- `README.md` のドキュメント一覧に移行指示書を追加

docs 影響: あり（`guide/セットアップガイド.md` / `README.md` — 本エントリで更新済み）

## [Unreleased] — 運用方針（C5: 版の追従方針）

### docs（版番号なし）

#### Added
- **`guide/運用ガイド.md` §1-2「いつ追従するか（版の方針）」**（C5 の決定）。
  02提案書 Phase 4 の積み残しだった「利用側の追従方針」を確定させた
  - **プラグイン層は常に最新へ追従**（コマンド2本と再起動で済み、判断が要らない）
  - **テンプレート層は区切りで追従**（競合の統合に人の判断が要るため、作業の途中に挟まない）
  - **`autoUpdate` は使わない**。プラグインはセッション起動時に読まれるため、
    自動で版が変わると「今このセッションが何を読んでいるか」が曖昧になる
  > 根拠は `bookmark-app` を 0.2.3 → 0.5.0 へ追従させた実測。プラグイン層は判断ゼロ、
  > テンプレート層は競合4件すべてに**中身を読む判断**が要った。
  > また `tools/export-to-sql.ts` の世代上限のように、**追従しないと直したはずの欠陥が
  > そのプロジェクトにだけ残る**実例も出ている
- 版を固定する場合の注意（固定していることを文書に残す / fail-open に関わる修正は例外）

#### Changed
- `guide/セットアップガイド.md` §6 の冒頭から運用ガイド §1-2 へリンク。**手順と方針を分けた**

docs 影響: あり（`guide/運用ガイド.md` / `guide/セットアップガイド.md` — 本エントリで更新済み）

## [Unreleased] — 還元 #22 / #23（フック通知の可視性を実測で決着させる）

**イベント横断の実測（Claude Code v2.1.232 / Windows・ProjectTemplete の実測キット）で
通知の届き方を確定させた。** これにより D5 の #17b の結論を**訂正**する。

| イベント | `systemMessage`（画面） | `additionalContext`（Claude の文脈） |
|---------|------------------------|-----------------------------------|
| SessionStart | ✅ | ✅ |
| PreToolUse | ✅ | ✅ |
| PostToolUse（Bash / Edit / Write / Task） | ✅ | ✅ |
| SubagentStop | ❌ | ❌ 親には届かない。**サブエージェント自身へ戻り、停止をキャンセルしてループする**（実測: 8回・42秒・23.7k トークン） |

> ### ⚠️ D5（`b22c887`）の #17b は誤りだった
>
> 「`systemMessage` は PostToolUse では画面に出ない」と判断して `additionalContext` へ**移した**が、
> **同じ Claude Code v2.1.232 で出る**。バージョン差ではなく**切り分けの誤り**である。
> 当時は「`--fix` は効くのに通知が来ない」という**1点の観測から出力形式を原因と断定**し、
> 他の原因を潰していなかった。結果として**ユーザーの画面から通知を自分で消していた**（#23）。
>
> §8 の教訓「1点の観測から一般化しない」の3例目。**片方の経路に賭けない**という形で構造的に潰した。

### harness-core 0.5.0

#### Fixed
- **通知を2経路とも出すようにした**（#23）。`harness-lib.js` に **`notify(hookEventName, message)`**
  を追加し、`systemMessage`（画面）と `hookSpecificOutput.additionalContext`（Claude の文脈）へ
  **同じ本文を同時に出す**。対象は `pre-commit-check` / `post-commit-doc-check`
- **ブロック時も画面に出るようにした**。`permissionDecisionReason` は Claude には届くが、
  同じ内容を `systemMessage` にも載せてユーザーにも見えるようにした

#### Changed
- **`subagent-stop-diff` を「通知」から「記録」へ変更**（#22）。SubagentStop には通知経路が無いため、
  この場では**何も出さず** `.claude/.subagent-touch.json` に `{agent, files}` を追記し、
  **`pre-commit-check` がコミット時に読み出して通知へ添える**
  > 移設先として PostToolUse（`Task`）も検証した。画面には出るが、**サブエージェントが
  > 背景実行の場合は起動直後に発火する**ため「終了時点の変更ファイル数」には使えない。
  > **届くイベントまで情報を持ち越す**方式にした。合流先をコミット時にしたのは、
  > 差分確認の督促が**最も効いてほしい瞬間**だから
  - **ブロックした場合は記録を書き戻す。** コミットが成立していない以上、次の試行でも出す
    （繰り返し出ても誤警報にならない ─ §8「安全弁は正常な操作で鳴らないことが要件」）
  - 記録が無ければ従来どおり**完全に無出力**（fail-open）

### harness-nextjs 0.2.1

#### Fixed
- `post-edit-lint` の通知を2経路とも出すようにした（#23）。**`Edit` / `Write` の PostToolUse でも
  `systemMessage` が画面に出ることを実測で確認**したうえでの復旧
- `pre-migrate-backup` の情報通知（初回スキップ / バックアップ完了）も2経路へ

### harness-unity 0.2.1

#### Fixed
- `pre-commit-cs-check` の通知を2経路とも出すようにした（#23）。エラーでブロックする場合も、
  理由が**ユーザーの画面に出る**ようになった

### テンプレート層 / docs

#### Changed
- `templates/base/.gitignore` に `.claude/.subagent-touch.json` を追加
- `docs/harness-config-contract.md` に §6-3（記録の受け渡し）と **§6-4（通知の届き方の実測表）** を追加
- `docs/diagrams/05_フック発火タイミング図.md` の「通知が届かない経路」を実測に合わせて全面改訂
- `docs/guide/運用ガイド.md` §5-3 を「通知は画面に出ない」から**実際の届き方**へ改訂

docs 影響: あり（`harness-config-contract.md` / `diagrams/05` / `guide/運用ガイド.md` —
いずれも本エントリで更新済み。`templates/base/.gitignore` の変更は利用側で
`/harness-core:harness-update` が要る）

## [Unreleased] — 還元 A（日本語校正 — AI が書いた文章の品質ゲート）

### harness-core 0.4.0

#### Added
- **`proofread-ja` スキル**と **`japanese-proofreader` エージェント**（還元 A・CommSim 由来）。
  ハーネスの成果物（`docs/features/` の設計書・`docs/reviews/` の記録・ガイド・CLAUDE.md）は
  **ほぼ全量が AI の書いた日本語**で、しかも長期間残って**後から読む人の判断材料になる**。
  環境非依存の共通課題であり core の責務に合う。
  位置づけは「校正」ではなく **「AI が書いた文章の品質ゲート」**
  - **モデルを固定しない。** 移植元は `model: fable` を持っていたが、
    **モデル名は将来変わる**ため、ハーネスが特定の名前を持つと名前が変わった時点で
    全プロジェクトが壊れる。`description` に「上位モデルを推奨」と書き、指定はプロジェクトの裁量とした
  - **パターン表（7分類）は core に持つ。** 「空表をテンプレートに置いて育てさせる」案は採らない。
    C1 で `ORDERED_TABLES` が空 TODO のまま放置されて事故になった（#8）のと同じ構造で、
    **空の器は埋められない**
  - プロジェクト固有の用語統一は `.claude/rules/` の担当と明記した（エージェント側には書かない）。
    移植元にあった製品固有の用語節は落とし、例も一般的な言い回しへ置き換えた（本リポジトリは public）
  - **`CHANGELOG.md` と各文書の改訂履歴は対象外**にした。**過去の記録は書き換えない**
  - エージェントの `tools` を **`Read, Edit, Grep, Glob` に絞った**（既存ファイルの書き換え専用）。
    `git` 操作もファイル新規作成もできないため、**コミットの判断がメイン側に残る**ことが構造上保証される。
    #13 の教訓（原因不明のまま `tools` を足すと逆に絞ってしまう）は**既存エージェントの話**であり、
    新規に設計するここでは意図した制限として宣言している
  - Step 3 の**メインでの差分レビューを必須**にした。文章の修正は typecheck も lint も通らず、
    **壊れても検出する仕組みが無い**ため（実際に文法破綻・強調範囲のずれが起きた実例がある）

docs 影響: あり（`guide/運用ガイド.md` §2-1・`diagrams/01_全体アーキテクチャ図.md` の対応表と要素数・
`README.md` のスキル表・`templates/base/CLAUDE.md` のスキル一覧 — いずれも本エントリで更新済み。
`templates/base/CLAUDE.md` の変更は利用側で `/harness-core:harness-update` が要る）

## [Unreleased] — 還元ラウンド（#24 / #25 / #26：運用の煩雑さを潰す）

C1 完了後の還元。**新規の発見が「実装の欠陥」から「運用の煩雑さ」へ移った**局面の3件で、
いずれもプラグインには触れていない（**版番号の変化なし**）。

### リポジトリ運用（版番号なし）

#### Added
- **`CLAUDE.md` をリポジトリ直下に追加**（#26）。ハーネス**自体**を開発するときの規律を置く場所が
  無かったため、テンプレート層の CLAUDE.md にはある規律がこのリポジトリには効いていなかった。
  中心は **「コミットは必ずパス指定。`git add -A` / `git add .` を使わない」**。
  > このリポジトリは**複数のセッションが同時に触る**（還元作業とドキュメント整備が並行するのが常態）。
  > インデックス全体をコミットすると別セッションの編集中ファイルを巻き込む。
  > **実際に起きた**（`b22c887` がドキュメント整備セッションの作業を巻き込んだ）
  - 同じ理由で `git checkout -- .` / `git restore .` / `git clean` の範囲指定なしと
    `git stash` も禁止に含めた
  - 併せて版番号2ファイル・`validate --strict`・CHANGELOG・fail-open 方針・
    「推測で直さない」「1点の観測から一般化しない」を集約
- `README.md` の「開発ルール」節は **CLAUDE.md への入口**に縮小（同じ情報を2箇所に置かない）

### テンプレート層（版番号なし）

#### Fixed
- **バックアップに世代上限が無かった**（#24）。`tools/export-to-sql.ts` は migrate のたびに
  1世代を作るが上限が無く、**無制限に溜まる**（SQLite の実測で1世代 52KB）。
  `.gitignore` 済みで git も刈らない。**新しい方から `BACKUP_GENERATIONS`（既定 10）世代を残して
  古い世代を自動削除する**ようにした
  - SQLite の `.bak`（ファイルコピー）と PostgreSQL の `dump_YYYYMMDD*.zip` の**両方**に効く。
    同じ欠陥を片方だけ直しても、隣に同じものが残るだけのため
  - `-wal` / `-shm` は本体の付随物なので**世代としては数えず、本体と一緒に**消す
  - **削除したファイルは必ずログに出す。** 黙って消すと「あるはずのバックアップが無い」の原因になる
  - 掃除の失敗はバックアップの失敗として扱わない（fail-open。掃除できないことは、
    バックアップが取れていないことより軽い）
  > 検証: SQLite のフィクスチャで 12 回連続実行し、**10 世代だけが残り、
  > 消えた2世代の `-wal` / `-shm` も一緒に消える**ことを確認

#### Changed
- **プラグインのスコープ運用を「`project` のみ」へ統一**（#25）。
  更新が「プラグイン数 × スコープ数」になり、**3回連続で当て漏れが発生**していた
  - `project` 側の登録は `enabledPlugins` によりセッション起動時に**自動生成される**ため、
    消しても復活する。**捨てられるのは `user` 側だけ**という非対称がこの結論の根拠
  - `user` スコープの利点（全プロジェクト共通で1回入れれば済む）は**そもそも効いていない**。
    `enabledPlugins` があっても初回起動では導入されず、結局プロジェクトごとに
    `claude plugin install` が要るため（A1 の実測）
  - 導入・更新・入れ直し・取り外しの**全例に `--scope project` を明示**し、
    既に `user` に入れている場合の移行手順（uninstall → 再起動）を追加した。
    対象: `docs/plugin-development.md` / `docs/guide/セットアップガイド.md` /
    `docs/diagrams/06_改善還元フロー図.md` / `README.md` / `templates/README.md` /
    `templates/unity/SETUP.md` / `templates/base/constitution.md` / `tools/create-project.mjs`
  - **ドライブレター重複（#4）は解消しない。** `project` スコープ側の問題であり、
    むしろ `project` のみにすると相対的に目立つ。根本対策は起動元のシェルを揃えること
  > `docs/background/` は意思決定記録（追従しない）ため、旧手順のまま残している

docs 影響: あり（`guide/セットアップガイド.md` §2・§6・§8 と `guide/運用ガイド.md` §5-5、
`diagrams/06_改善還元フロー図.md`、`plugin-development.md` — いずれも本エントリで更新済み。
`templates/base/constitution.md` の変更は利用側で `/harness-core:harness-update` が要る）

## [Unreleased] — D5（C1 2周目の還元：hooks の実測で判明した欠陥）

C1 2周目で hooks を実測した結果の修正。
1周目で唯一未回答だった「hooks の発火頻度・待ち時間が実用範囲か」への回答が
**「外れている」**だったため、その原因を潰した。

### harness-core 0.2.3

#### Fixed
- **`post-commit-doc-check` の通知が届いていなかった**（#17b）。
  `systemMessage` は **PostToolUse では画面に出ない**ことが実測で確定したため、
  SessionStart と同じ `hookSpecificOutput.additionalContext` へ変更した。
  > 検証方法: 自動修正できる指摘（`prefer-const`）と自動修正できない error を
  > 同居させたファイルを編集し、**`--fix` は適用されるのに通知だけ届かない**ことを確認。
  > フックは走っており `catch` にも入っているため、出力形式の問題だと切り分けられた。

### harness-nextjs 0.1.2

#### Fixed
- **`post-edit-lint` が `npx` 経由で eslint を起動していた**（#17a）。
  スクリプト内で `node_modules/.bin/eslint` のパスを確定させているのに実行は `npx` で、
  毎編集に**約 0.9 秒**（全体の約 24%・実測）が上乗せされていた。直接起動へ変更。
  Windows の `.cmd` ラッパーも解決する
  > **これは主因ではない。** 実測では ESLint 自身の起動（設定解決・TS パーサ・
  > プラグイン読み込み）が約 2.76 秒を占め、**対象ファイル数がほぼ効いていない**。
  > 4.2 秒 → 3.3 秒程度の改善にとどまる。体感を大きく変えるには常駐化か
  > 連続編集のバッチ化が要る（未対応・`docs/backlog-phase0-findings.md` 級の課題）
- **`post-edit-lint` の「自動修正できない指摘」の通知が届いていなかった**（#17b）。
  上記 `post-commit-doc-check` と同じ原因。**フックの価値の半分が失われていた**
  （lint エラー2件を抱えたまま実装が進み、`npm run lint` を回すまで気づかなかった）
- **`pre-migrate-backup` が読み取り専用の呼び出しでも発火していた**（#16）。
  判定が `prisma migrate\b` の前方一致だけで、`migrate status` / `migrate diff` /
  `--help` でもバックアップが走っていた。**実 migrate ゼロ回で同一内容の `.bak` が
  7 個溜まった**（実測）。ヘッダに書かれた「実際に実行するときのみ」という
  設計意図に実装を合わせた
  - `resolve` は `_prisma_migrations` を書き換えるため**除外しない**
  - 11 ケース（`dev` / `deploy` / `reset` / `resolve` / `status` / `diff` / `--help` /
    `-h` / 環境変数付き / コミットメッセージ内の文字列 / 無関係コマンド）で判定を確認

#### 未対応（記録）
- `systemMessage` は **PreToolUse / PreCompact / SubagentStop でも surface されない可能性**がある
  （`pre-commit-check` の情報通知・`pre-compact-save`・`subagent-stop-diff` が該当）。
  今回**実測できたのは PostToolUse のみ**のため、他は変更していない。
  ブロック系（`permissionDecision` / `continue:false`）は実際に効いていることが確認済み

## [Unreleased] — ドキュメント整備（図・ガイド）

### テンプレート層（版番号なし）／ docs

#### Added
- **`docs/diagrams/01_全体アーキテクチャ図.md`**（D-1）— marketplace → プラグイン（core / env）→
  利用側プロジェクトの**静的な構造**。`templates/` と `create-project.mjs` の位置づけ、
  **2層（プラグイン層 / テンプレート層）の違い**、`harness.config.json` が両者を結ぶ関係を1枚に
- **`docs/diagrams/02_開発フロー図.md`**（D-2）— 規模判定から push までを
  **承認ゲートの位置と戻り経路**に絞って図示。ゲートは4つ（規模 / Stage 1 / Stage 2 / コミット前フック）で、
  **人が判断しないのはフックだけ**。Stage 2 → Stage 1 の戻りと、実装中のスコープ拡大による再判定を明示。
  スキル一覧・判定基準は CLAUDE.md と `開発フローと規模判定.md` にあるため重複させていない
- **`docs/diagrams/04_スキル実行シーケンス図.md`**（D-4）— `/harness-core:code-review` を例に
  スキル1本の内部動作を図示（D-3 の具体例という位置づけ）。
  `.claude/rules/` が自動ロードされること、観点3層、`verification` による動作確認案内、
  結果をファイルに残し要約だけ返す共通構造を示す
- **`docs/diagrams/03_役割比較図.md`**（D-3）— スキル / サブエージェント / フック / MCP /
  テンプレート層の**5要素**を「誰が呼ぶか・どこで動くか・文脈を共有するか・失敗時の既定」で比較。
  **MCP はハーネスが配らず、環境プラグインが前提として要求するだけ**である点を明示
- **`docs/diagrams/05_フック発火タイミング図.md`**（D-5）— **権限層（deny / ask / allow）が
  フックより手前にある**こと、config 不在時の **fail-open** 経路、そして
  **発火しても通知が届かない経路**（`systemMessage` は PostToolUse で surface されず、
  `additionalContext` は Claude には届くが画面に出ない）を1枚に。
  `prisma migrate reset` の deny 削除（`b18c666`）前後の対比を実例として収録
- **`docs/diagrams/06_改善還元フロー図.md`**（D-6）— 「直した」と「配信された」の間にある
  版番号・コミット・push・update・再起動の**5つの関門**を図にした。
  C1 で実際に踏んだ「直したのに1件も届いていなかった」事故の再発防止
- **`docs/guide/セットアップガイド.md`**（G-4）— 新規生成 → **`claude plugin install`（必須）** →
  導入確認（`/plugin`・`/`）→ 環境ごとの追加手順 → よくある失敗。
  **既存プロジェクトへの後付け導入（未実測）と取り外し手順**を含む
- **`docs/guide/入門ガイド.md`**（G-1）— 初めて使う人向け。期待値調整 → 3原則 →
  S 規模で1機能を通す実例 → **つまずきポイント7件**。
  7件はドッグフーディングで実際に手が止まった箇所の記録で、
  **修正済みのものは「現在」の状態を併記**している（古い状態のまま書かない）
- **`docs/guide/運用ガイド.md`**（G-2）— スキルの使い分け・規模判定・サブエージェント・
  フックの挙動（**待ち時間と通知の可視性は実測値**）・設計書と台帳の運用・環境ごとの違い。
  構造の説明は図6本へ委譲し、**判断の基準**に絞った（旧計896行 → 計520行）
- **`docs/guide/オプションMCP追加ガイド.md`**（G-3）— 統合前テンプレートの同名ガイド（479行）を
  環境非依存へ書き換えて移設。**扱うのは「標準以外の MCP を足したいとき」だけ**とし、
  環境プラグインが前提とする Playwright / Unity MCP は範囲外（役割比較図とセットアップガイドへ委譲）。
  スキル名を名前空間付きへ更新し、環境固有の注意（drawio MCP と dev server のポート競合）は
  **【nextjs】** と明示して分離
- **`docs/background/01_統合前後の差異.md`**（B-1）/ **`docs/background/02_SpecKitとの差異.md`**（B-2）—
  統合検討時の差異解説2本（HTML 計1,671行）を Markdown へ変換して収録。
  **`docs/background/` は「なぜそうしたか」の意思決定記録**であり、
  実装変更に追従しない（`docs/guide/` との性質の違いを各冒頭に明記）。
  B-2 の §3 フロー対比は **mermaid 化**し、Spec Kit とハーネスの2本のフローを
  **「誰が起動するか」（人 / AI / 自動 hooks）で塗り分けた**。
  公開にあたり実プロジェクト名と絶対パスを伏せた
- CHANGELOG の書式に **`docs 影響`** 欄の運用を追加（本ファイル冒頭）

#### Changed
- `README.md` の導入情報をセットアップガイドへ集約し、概要＋リンクに縮小
- `templates/base/CLAUDE.md` にセットアップガイドと改善還元フロー図へのリンクを追加
- `templates/README.md` の**誤った導入確認方法を修正**
  （「起動時の `[harness] environment: <env>` の表示で判別する」→ `/plugin` と `/` で確認）。
  `additionalContext` は画面に出ないため、この確認方法は成立しない

docs 影響: あり（本エントリ自体が docs の追加。`templates/base/CLAUDE.md` の変更は
利用側で `/harness-core:harness-update` が要る）

## [Unreleased] — D3（`finalize` の競合解決判定）

### harness-core 0.2.2

#### Fixed
- **`harness-diff.mjs finalize` が、正しく解決した競合まで「未解決」と判定していた**（C1 の還元 #14）。
  解決条件を「現物 == 最新テンプレート」の完全一致にしていたが、
  **競合の正しい解決は多くの場合「テンプレートの改善 + ローカル改変の統合」**であり、
  必然的にテンプレートとは一致しない。
  そのため**正しく統合するほど `--force` を要求され**、本来「見送り」用の安全弁が
  日常操作になって鈍っていた（C1 の追従で2回とも要求された）。
  - 判定軸を「**`analyze` 以降にそのファイルへ手を入れたか**」へ変更（内容のハッシュで比較）
  - `analyze` が競合ファイルの現物のハッシュを `report.json` に記録する
  - 統合した / テンプレートを丸ごと採った → **解決**。手つかず → 従来どおり `--force` が要る
  - ハッシュは `readText` の正規化後（BOM・CRLF を落とした後）の内容に対して取るため、
    **改行コードの違いだけで「変更された」と誤判定しない**
  - `currentHash` を持たない古い `report.json` は従来の判定にフォールバックする
  - `harness-update` の SKILL.md にも判定表と、一致で判定してはならない理由を明記

  > **安全弁は、正常な操作で鳴らないことが要件**である。正しい手順で毎回鳴る警告は、
  > 鳴らすべき場面でも無視されるようになる。

## [Unreleased] — D1 追補（SQLite のバックアップ対応）

### テンプレート層（版番号なし）

#### Added
- **`tools/export-to-sql.ts` が SQLite をファイルコピーでバックアップするようにした。**
  D1 #8 で「`postgresql` 以外は明示的に失敗」としたが、**SQLite 利用者に前へ進む道が無く、
  `prisma migrate` が恒久的にブロックされる**状態だった（C1 の `harness-update` 適用時に判明）。
  - SQLite は DB がファイルそのものなので、**コピーの方が SQL ダンプより確実**
  - `DATABASE_URL` は環境変数 →`prisma/.env` → `.env` の順に解決する
    （`tsx` は `.env` を自動で読まないため）
  - `file:./dev.db` の相対パスは **schema.prisma からの相対**として解決する（Prisma の仕様）
  - WAL モードの `-wal` / `-shm` が存在すれば一緒にコピーする
  - タイムスタンプからコロンを除去する（Windows のファイル名に使えないため）
  - **場所を特定できない場合は成功扱いにしない**（#8 と同じ理由。
    取れていないバックアップを「成功」と報告しない）

  > 対応方針として「プロジェクト側でバックアップ手段を差し替える」案もあったが、
  > constitution §8 が禁じるローカル乖離になるため**テンプレート側で対応**した。

## [Unreleased] — D2（C1 還元・優先度 B：`new-feature` の入口の質）

C1 1周目で「往復が増えた」「1手無駄になった」箇所の改善。
**効果は C1 2周目で測る**（質問ラウンド数が 3 → 1〜2 に減るか）。

### harness-core 0.2.1

#### Added
- **Step 0「プロジェクトが初期化済みかを確認」を追加**（#5）。
  空・未初期化のリポジトリで呼ばれるのは珍しくない（初回の機能開発＝土台構築）が、
  扱いが規定されておらず AI が毎回その場で判断を組み立てていた。
  - 判定は `harness.config.json` の `paths.source` に実ファイルがあるかで行う
    （環境ごとの条件をハードコードせず設定契約から導く）
  - **初期化を `Phase 0` として同じ設計書に含める**のを既定とした。
    別作業に切り出すと受け入れ基準が「動くもの」にならず、タスクと実装の対応が崩れる
  - 初期化を含めるとほぼ必ず L 規模になる旨も明記
- **Step 2 に「定番の観点チェックリスト」を追加**（#6）。
  永続化先 / データ構造 / 一意制約と重複 / 破壊的操作の UX / 従属データの掃除 /
  一覧の並び順とページング / 画面配置 などを表で列挙し、
  **質問をまとめてから聞く**ことを明示（`AskUserQuestion` は1回4問まで）。
  > とくに「**永続化先が今この開発機で動くか**」は、確認を怠ると設計確定後に改訂が要る。
  > C1 では PostgreSQL 前提で設計したあと開発機に無いことが判明し、SQLite へ改訂した

#### Changed
- **Step 3 に「Step 2 の回答で Stage 1 が埋まるならそのまま記入してよい」と明記**（#7）。
  作成と記入が別手に読め、L 規模の入口が1手増えていた。
  あわせて 3-3（未解決事項）へ**質問の選択肢と回答をそのまま転記する**ことを推奨に加えた
  （「なぜその設計にしたか」が設計書に残る。C1 で有効性を確認済み）

### テンプレート層（版番号なし）

#### Added
- `templates/nextjs/CLAUDE.section.md` に**「プロジェクトの初期化（`create-next-app`）」節**を追加（#12）。
  ハーネス適用済みリポジトリは既に非空なので、`create-next-app` は必ず詰まるか既存ファイルを壊す。
  - 非空ディレクトリでの失敗 → 一時ディレクトリ経由
  - **生成物の `CLAUDE.md` / `AGENTS.md` を取り込むとハーネスの `CLAUDE.md` を壊す** → 移す前に除外する
  - `.gitignore` の上書き（`!.env.example` の消失）
  - `eslint.config.mjs` への `.claude/**` 追加（#11 の残り半分をここへ統合）

  > 配置先はトリアージ案の `plugins/harness-nextjs` ではなくテンプレート層とした。
  > **初期化時点ではまだファイルが無く `.claude/rules/` のパストリガーが発火しない**ため、
  > 常時ロードされる CLAUDE.md 側でないと届かない。

## [Unreleased] — D1（C1 還元・優先度 A：初回体験を壊す欠陥）

C1（`bookmark-app` での初回ドッグフーディング）1周目で見つかった、
**新規プロジェクトの初回体験を壊す4件**を修正した。
記録: ProjectTemplete `docs/12_C1実施記録と還元トリアージ.md`

### harness-nextjs 0.1.1

#### Fixed
- **`pre-migrate-backup` が初回 migrate を必ずブロックする問題を修正**（#10）。
  新規プロジェクトでは `ORDERED_TABLES` が当然まだ空なので、
  「バックアップ対象が未設定」として毎回止まっていた。
  `prisma/migrations/` に適用済みマイグレーションが1件も無い場合は
  **保護すべきスキーマもデータも存在しない**ため、警告付きでスキップするようにした。
  migrations が1件でもあれば従来どおりブロックする。
  constitution §7 の fail-open 原則（失うものが無い場面で止めない）に沿わせた修正

### テンプレート層（版番号なし）

#### Fixed
- **`tools/export-to-sql.ts` が非対応 provider で「壊れたバックアップを成功と報告」する問題を修正**（#8）。
  出力 SQL は PostgreSQL 方言に固定（`TRUNCATE ... CASCADE` / `public."X"` / `ARRAY[...]::text[]`）だが、
  読み出しは Prisma 経由で provider 非依存のため、SQLite プロジェクトでも**成功してしまっていた**。
  `prisma/schema.prisma` の datasource provider を見て、`postgresql` 以外なら
  **明示的に失敗させる**（対処の選択肢を提示する）。provider を判定できない場合は警告のみで続行する。
  > バックアップが無いことより、**壊れたバックアップを信じて破壊的操作に進む方が危険**なため、
  > 素通しではなく停止を選んだ
- **deny の `.env*` が `.env.example` を巻き込んでいた問題を修正**（#9）。
  `.gitignore` の `!.env.example`（コミット対象）と矛盾しており、
  AI が雛形を読むことも更新することもできなかった。deny はツール層で「今回だけ許可」ができないため
  シェル経由の迂回を誘発する。**実際に秘密を持つファイルだけを列挙**する形へ変更した
  （`docs/permissions-baseline.md` §5-7 に経緯と残余リスクを記録。R5 に対する意図的な例外）
- **新規プロジェクトの `npm run lint` が初回から失敗する問題に対応**（#11）。
  - `tools/scripts/generate-table-docs.ts` の `prefer-const` 違反と未使用変数2件を修正
  - `.claude/statusline.js` は Node 直実行の CommonJS で `require()` が避けられないため、
    `CLAUDE.section.md`（nextjs）に **`eslint.config.mjs` の `globalIgnores` へ `.claude/**` を追加する**
    手順を明記した。除外しないとアプリのコードが0行の時点で build-check が赤くなる

#### Fixed（`claude plugin validate --strict` が検出）
- `marketplace.json` の `harness-unity` エントリが `0.1.0` のままで、
  `plugin.json`（`0.2.0`）と**不一致だった**。B1 の版上げで片側を忘れていた。
  install 時は plugin.json が優先されるため実害は出ていなかったが、
  `plugin-development.md` が「両方上げること」と定めている以上の不整合なので修正した

## [Unreleased] — B1（`unity-verify` の Play モード手順の確定）

### harness-unity 0.2.0

#### Added
- **`unity-verify` に「Step 4.5: Play モードでの確認」を追加**。
  唯一残っていた `[NEEDS CLARIFICATION]` を解消した。手順は推測ではなく、
  MCP for Unity の実装コードと**実運用プロジェクトでの成功した呼び出し列**から確定させている
  （調査記録: ProjectTemplete `docs/reviews/20260814_151615_B1_UnityMCP_Playモード調査.md`）
  - 開始 `manage_editor {action:"play"}` / 停止 `manage_editor {action:"stop"}`（ともに冪等）
  - 状態の待機は MCP リソース `mcpforunity://editor/state` のポーリング
    （`editor.play_mode.is_playing` / `is_changing` / `activity.phase`）。
    リソースが読めない場合の `execute_code` による代替手順も併記した
  - **前提条件として `PlayerSettings.runInBackground = true` を明記**。false のままだと
    Editor が非アクティブな間ゲームが進まず、MCP 経由の Play モード確認が成立しない（実測で確認）
  - 画面確認に `manage_camera {action:"screenshot", include_image:true, max_resolution:900}` を追加
  - 時間経過の待機は Bash の until ループ（PowerShell の `Start-Sleep` はハーネスにブロックされる）
- Step 4 に `refresh_unity {compile:"request", wait_for_ready:true}` を明記。
  「再コンパイル完了を待つ」の具体手順が無かった

#### Changed
- `allowed-tools` に `Bash(until:*)` / `ReadMcpResourceTool` / `mcp__UnityMCP__*` を追加。
  Step 3・Step 4 の時点で既に MCP ツールを使う手順だったが宣言に含まれていなかった（既存の不備）
- Step 5 の報告フォーマットに「Play モード確認」行を追加。
  「確認できていないこと」を*面白さ・操作感・難易度バランス*と*見た目の判断*に分けて明記した
  （静止画は撮れるようになったが、良し悪しの判断は依然ユーザーが行うため）

> **`verification.manualGate: true` は変更していない。**
> Play モードで分かるのは「例外が出ないか」「進行するか」「数値状態」「静止画」までであり、
> 体感確認を代替しないという原則は維持する。

## [Unreleased] — Phase 3（harness-update と後始末）

### harness-core 0.2.0

#### Added
- **`harness-update` スキルを実装**（Phase 1 では骨子のみだった）。
  テンプレート層（CLAUDE.md / constitution.md / `.claude/rules/` / `harness.config.json` / docs 骨格）を
  最新へ追従させる。差分エンジン `scripts/harness-diff.mjs`（`analyze` / `apply` / `finalize`）を同梱
  - 取得は `git clone --depth 1`。`--repo <path>` でローカルクローンも使える（オフライン用）
  - **3点比較**（A=baseline 時点 / B=最新 / C=現物）で差分を機械的に分類する。
    A・B は**クローン側の `create-project.mjs` をその時点のコミットで実行して再現**するため、
    合成規則の二重実装が発生しない
  - 分類: `template-improvement` / `project-local` / `already-applied` / `conflict` / `template-removed`
  - `apply` は**競合ファイルの上書きを拒否**する（ローカル改変の無断上書き禁止の機械的担保）
  - `finalize` は**未解決の競合が残っていると中断**する（`--force` で明示的に見送れる）。
    baseline を進めるとテンプレート側の変更が視界から消えるため
  - `docs/features/` / `docs/reviews/` / `docs/設計書/`（台帳を除く）は追従対象外

#### Changed
- `harness.config.json` は**スキーマ差分**として扱う（新フィールドの追加提案・既存値の保持・
  `schemaVersion` 引き上げ時のユーザー承認）

#### Fixed（Phase 3 レビューでの修正）
- `analyze` がプロジェクトの全ツリーを walk していた問題を修正。C にしか無いファイルは定義上すべて
  対象外のため比較には不要で、実プロジェクトでは node_modules / Unity の Library / .next 等の
  巨大ツリーを舐めて解析が破綻しうる。比較対象を A ∪ B のファイル集合に限定した
- `apply` が `project-local`（プロジェクト固有の改変）の上書きを拒否するようにした（`--force` で
  意図的な巻き戻しのみ許可）。競合と同様、ローカル改変の無断上書き禁止をコードで担保する
- `finalize` が未解決の `template-removed`（テンプレート側で削除されたがプロジェクトに残っている
  ファイル）を黙って飲み込まないよう、警告を出すようにした（残す判断は有効なのでブロックはしない）

### テンプレート層

#### Added
- `.claude/harness-baseline.json` を `create-project.mjs` が生成するようにした。
  内容: `templatesCommit` / `environment` / `appliedAt` / `placeholders`。
  `harness-update` が「前回どの時点を適用したか」と「どの置換値で生成されたか」を知るために使う。
  **このファイルはコミットする**（チーム全員が同じ基準点を使うため）
- `templates/base/.gitattributes` を追加。生成されたプロジェクトにも LF 固定を引き継ぐ
  （無いと Windows の `core.autocrlf=true` で作業ツリーが CRLF になり、
  `harness-update` の3点比較で全ファイルが差分として出る）
- `templates/base/.gitignore` に `.claude/.harness-update/`（作業ディレクトリ）を追加

---

## [Phase 2] — 環境モジュールとテンプレート層（2026-08-14）

### harness-nextjs 0.1.0 / harness-unity 0.1.0 / harness-wpf 0.1.0（新規）

#### Added
- **harness-nextjs**: `browser-test` スキル（Playwright MCP）/ `browser-tester`・`product-advisor` エージェント /
  `post-edit-lint`・`pre-migrate-backup` フック
- **harness-unity**: `unity-verify` スキル（Unity MCP）/ `game-designer` エージェント /
  `pre-commit-cs-check` フック
- **harness-wpf**: `capture-screenshots` スキル（UIAutomation）/ `product-advisor` エージェント /
  `ui-capture.ps1`

環境プラグインの hooks は **core の `harness-lib.js` を require しない**。
`${CLAUDE_PLUGIN_ROOT}` はプラグインごとに異なりプラグイン間参照が保証されないため、
必要な最小ヘルパ（`plugin-lib.js`）を各プラグインが自前で持つ。重複は意図的。

### テンプレート層（新規）

#### Added
- `templates/base`（CLAUDE.md 共通部 / `constitution.md` / `settings.json` / `statusline.js` / docs 骨格）
- `templates/{nextjs,unity,wpf}`（`CLAUDE.section.md` / `.claude/rules/` / `harness.config.json` / 設計書の空枠）
- `tools/create-project.mjs` — base + env を合成してプロジェクトを生成する
  （プレースホルダ置換・`--dry-run`・Node 標準ライブラリのみ）。
  WPF テンプレートの `init-template.ps1` の Node 移植

### 設定契約

#### Added
- `envOptions`（任意フィールド）— 環境プラグイン専用の値置き場。core は読まない。
  現在の利用箇所は `envOptions.rootNamespace`（Unity の namespace 検査）

### Fixed
- **F5**: Unity の `pre-commit-cs-check` にあった namespace `YourApp` のハードコードを
  `envOptions.rootNamespace` 駆動へ。**未設定なら namespace 検査だけスキップ**（fail-open）
- **R1**: browser-test 系が機能設計書を節番号（「§4」「§5」）で参照していたのを**見出し名参照**へ
- `pre-migrate-backup` が `ORDERED_TABLES` 空のまま**空バックアップを黙って作る**問題を、
  検出してブロックするように変更
- nextjs の rules 索引と実ファイルの `paths` の不一致
- `pre-commit-cs-check` のヘッダコメントと実装の齟齬（`Assets/` と `Assets/Scripts/`）
- **permissions**: `Bash(rm -rf *)` が `rm -fr` 等の綴り違いを取りこぼしていた（実機検証で発見）。
  `Bash(rm -r*)` / `(rm -f*)` / `(rm --recursive*)` / `(rm --force*)` の列挙へ書き直し
- `.ps1` を UTF-8 BOM 付きに統一（Windows PowerShell 5.1 の CP932 誤読対策）

### レビュー修正（Phase 2 レビュー）
- 「作業中の機能設計書は `docs/features/pending/`」という誤記を6ファイルで修正。
  **正しくは作業中は `docs/features/` 直下**（`pending/` は一部保留の置き場）。
  core の `session-start-context` / `sync-check` は直下だけを見るため、
  `pending/` に置くとハーネスから見えなくなる
- `pre-migrate-backup` の `execSync(..., stdio: "inherit")` を `pipe` へ。
  **hook の stdout は JSON のみ**という公式仕様があり、子プロセスの出力が混ざると
  パース失敗で `continue:false` が無効化されるため

---

## [0.1.1] — Phase 1.1（レビュー指摘対応・2026-08-14）

### Fixed
- **R-1**: ゲートの合計時間が hook timeout を超えるとコミットが無検査で通る問題。
  各コマンドのタイムアウトを `min(MAX_COMMAND_MS, 残り予算 / 残りコマンド数)` とし、
  **タイムアウトは失敗扱いで deny** する
- **R-2**: `post-commit-doc-check` がコミットの成否を見ていなかった問題。
  `.claude/.pre-commit-head`（HEAD 記録）→ `git reflog` の2段構えで成立を確認する
- **R-3**〜**R-7**: `git commit` 検知の正規表現、`commands` のキー不在と null の区別、ほか

### 実測メモ
- 現行の Claude Code では **Bash ツールが非ゼロ終了した場合 PostToolUse hook は発火しない**

---

## [0.1.0] — Phase 1（harness-core の抽出・2026-08-14）

### Added
- `harness-core` プラグイン — 3テンプレート（nextjs / Unity / WPF）から環境非依存部分を抽出
  - スキル10本: `new-feature` / `design-review` / `code-review` / `build-check` / `update-docs` /
    `sync-check` / `complete-feature` / `pre-push-check` / `done` / `harness-update`（骨子）
  - エージェント3本: `coding-specialist` / `code-reviewer` / `documentation-manager`
  - フック5本: SessionStart / PreCompact / PreToolUse / PostToolUse / SubagentStop
- **設定契約 `.claude/harness.config.json`（schemaVersion 1）** — hooks / skills は全てこれを読んで動く
- `marketplace.json` — `extraKnownMarketplaces` 経由で認証なしに導入できる

### 設計原則
- すべて Node.js（CommonJS）。PowerShell / Bash スクリプトは使わない
- 発火判定は matcher に頼らず、stdin JSON の `tool_input.command` を各スクリプトで判定する
- config 不在・パース失敗・コマンド未定義は **`exit 0` で素通り**（fail-open）
- ブロック強度: 自己修復可能な失敗は `permissionDecision:"deny"`、
  人間判断が要る場合のみ `continue:false`
