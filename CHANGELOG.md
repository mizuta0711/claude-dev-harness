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
- **`docs/diagrams/03_役割比較図.md`**（D-3）— スキル / サブエージェント / フック / MCP /
  テンプレート層の**5要素**を「誰が呼ぶか・どこで動くか・文脈を共有するか・失敗時の既定」で比較。
  **MCP はハーネスが配らず、環境プラグインが前提として要求するだけ**である点を明示
- **`docs/diagrams/06_改善還元フロー図.md`**（D-6）— 「直した」と「配信された」の間にある
  版番号・コミット・push・update・再起動の**5つの関門**を図にした。
  C1 で実際に踏んだ「直したのに1件も届いていなかった」事故の再発防止
- **`docs/guide/セットアップガイド.md`**（G-4）— 新規生成 → **`claude plugin install`（必須）** →
  導入確認（`/plugin`・`/`）→ 環境ごとの追加手順 → よくある失敗。
  **既存プロジェクトへの後付け導入（未実測）と取り外し手順**を含む
- **`docs/guide/オプションMCP追加ガイド.md`**（G-3）— 統合前テンプレートの同名ガイド（479行）を
  環境非依存へ書き換えて移設。**扱うのは「標準以外の MCP を足したいとき」だけ**とし、
  環境プラグインが前提とする Playwright / Unity MCP は範囲外（役割比較図とセットアップガイドへ委譲）。
  スキル名を名前空間付きへ更新し、環境固有の注意（drawio MCP と dev server のポート競合）は
  **【nextjs】** と明示して分離
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
