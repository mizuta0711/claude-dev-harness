---
name: add-distribution-site
description: WPF アプリの配布サイト（トップ・機能・ダウンロード・更新履歴・マニュアルの枠）を web/ に置き、版の一覧 downloads.json・公開手順（Nginx の設定例と VPS の手順書）・リンクと版の検査 tools/check-web.mjs までをそろえる。「配布サイトを作って」「ダウンロードページを用意したい」「マニュアルの置き場を作って」「アプリを配布できる形にしたい」のときに使う。配布一式（add-distribution-site → add-help-window → add-installer）の 1 本目。サイトの公開そのもの（VPS への配置・GitHub の Release）は行わない。
allowed-tools: "Bash, PowerShell, Read, Write, Edit, Glob, Grep"
---

# 配布サイトの骨組みを置く

雛形は `${CLAUDE_PLUGIN_ROOT}/skills/add-distribution-site/templates/` にある（プロジェクトの中と同じ相対パスで並んでいる）。
写して値を置き換えるのは同梱の `scripts/apply.mjs` が行う。

## 何を作るか

| 置くもの | 中身 |
|---|---|
| `web/index.html`・`features.html`・`download.html`・`changelog.html` | 配布サイトの骨組み。文言は例文で、`<!-- 雛形: -->` の印の所をアプリに合わせて書き換える |
| `web/assets/css/style.css`・`assets/js/main.js`・`assets/img/` | 見た目（黒を基調、差し色は CSS 変数 1 か所）・ダウンロードの表示・マニュアルの左の目次 |
| `web/downloads.json`・`web/downloads/README.md` | 版の一覧（ダウンロードページ・更新履歴・トップの版表示が読む）とインストーラーの置き場 |
| `web/deploy/site.nginx.conf`・`web/deploy/vps-runbook.md` | Nginx の設定例とサーバでの公開手順（**手順書まで。公開はしない**） |
| `web/manual/`（入口・はじめに・インストールと削除・よくある質問・改訂履歴・`screens/main.html`） | マニュアルの**枠だけ**。見出しと「本文は plan-doc で書く」の印。本文は harness-doc が書く |
| `tools/check-web.mjs` | リンク切れ・外部の読み込み・F1 の飛び先の実在・版の食い違い・公開前の大きさと SHA-256 を見る（Node 標準だけ） |

任意: `--with-safety` で「消えるものと戻し方」（`web/manual/safety.html`）も置く。**アプリがデータを消す・上書きする操作を持つときだけ**使う。

プロジェクトへは写さない参考: `brief-draft.md`（マニュアルの文書群ブリーフの案。harness-doc に渡す）。

## 配布一式の 3 本と順序

| 順 | スキル | 受け持ち | このスキルとの約束 |
|---|---|---|---|
| 1 | **add-distribution-site**（これ） | `web/`・`downloads.json`・`web/deploy/`・`check-web.mjs`・マニュアルの枠 | — |
| 2 | `add-help-window` | WebView2 のヘルプ窓・F1・`{{UI_PROJECT_DIR}}/Services/HelpTargets.cs`（F1 の飛び先の表）・csproj で `web/manual/**` と `web/assets/**`（`assets/img/site/` を除く）を出力の `Help\` へ写す | `check-web.mjs` が `HelpTargets.cs` の `"manual/....html(#id)"` の文字列を拾って実在を見る。**飛び先の表はこのファイル 1 か所にだけ持つ** |
| 3 | `add-installer` | Inno Setup の `.iss`・`tools/build-installer.ps1`・`tools/publish-release.ps1` | build-installer が `downloads.json` を書く。publish-release はタグを打つ前に `node tools/check-web.mjs --dist dist` を呼ぶ |

**この順に入れる。** 2 が無い間は F1 の照合を警告で飛ばし、3 が無い間は `downloads.json` の大きさと SHA-256 が空のまま（ダウンロードページは「公開時に表示します」と出す）。
マニュアルの本文は `/harness-doc:plan-doc` → `manual-writer`、画面写真は `/harness-wpf:capture-screenshots` が受け持つ。

### `downloads.json` の形（add-installer と共有の約束）

```json
{
  "latest": "1.0.0",
  "versions": [
    {
      "version": "1.0.0",
      "date": "2026-01-31",
      "notes": ["最初の版"],
      "files": [
        { "kind": "bundled",   "name": "<APP_NAME>-1.0.0-win-x64-setup.exe",           "size": 50100387, "sha256": "…" },
        { "kind": "noruntime", "name": "<APP_NAME>-1.0.0-win-x64-noruntime-setup.exe", "size": 3922297,  "sha256": "…" }
      ]
    }
  ]
}
```

- ファイル名は **`{{APP_NAME}}-<版>-win-x64-setup.exe`（ランタイムあり）と `{{APP_NAME}}-<版>-win-x64-noruntime-setup.exe`（ランタイムなし）** に決まっている。`check-web.mjs` がこの名前で照合する
- `kind` は `bundled` と `noruntime` の 2 つ。`name` は `web/downloads/` からの相対
- `size` と `sha256` は作成スクリプトが**実物から計算して**書く（手で書かない）
- 同じ版で作り直したときは、その版の `date` と `files` だけを置き換え、`notes` は保つ。新しい版は先頭に足し、`latest` を変える
- `notes` が更新履歴ページとダウンロードのカードにそのまま出る（`changelog.html` には直接書かない）
- `latest` は `{{UI_CSPROJ}}` の `<Version>` と一致させる（版の元は csproj の 1 か所）

## 差し替える値の一覧

雛形の `{{名前}}` を置き換える。**値はまず実物から読み、案を表にして利用者に 1 回で確かめる。**

| 名前 | 意味 | どこから読むか・案の作り方 | 例 |
|---|---|---|---|
| `{{APP_NAME}}` | アプリの表示名。**インストーラーのファイル名にも使う** | csproj の `<Product>`・`<AssemblyName>`、無ければリポジトリ名。**英数字・`-`・`.` だけ**（add-installer と同じ規則。apply.mjs が止める。値は HTML へ入るとき文字参照にされる） | `SampleApp` |
| `{{TAGLINE}}` | このアプリが解決すること（1 文）。トップの見出し・説明文・フッター | 利用者に聞く | `散らかったフォルダを、中身を確かめてから片付けます。` |
| `{{PRICE_TERMS}}` | 価格と利用条件（トップとダウンロードページ） | 利用者に聞く | `無料で使えます。使った結果について、作者は責任を負いません。` |
| `{{ACCENT_COLOR}}` | 差し色（CSS の `--accent`・ロゴ） | 利用者に聞く。**暗い背景で映える明るめの色**（ボタンの文字が暗い色のため） | `#5aa2ff` |
| `{{SITE_URL}}` | 配布サイトのトップ。**末尾 `/`**。マニュアルの中で許す唯一の絶対 URL | 利用者に聞く（`https://` で始める） | `https://app.example.com/` |
| `{{SITE_HOST}}` | 配布サイトのホスト名（Nginx・certbot） | `{{SITE_URL}}` から取る | `app.example.com` |
| `{{SITE_SLUG}}` | サーバの Nginx の設定名・ログの名前 | `{{APP_NAME}}` を小文字にした案 | `sampleapp` |
| `{{UI_CSPROJ}}` | UI の csproj（リポジトリからの相対パス。区切りは `/` でも `\` でもよく、3 本で同じ csproj を指していればよい）。版の元 | `<UseWPF>true</UseWPF>` を持つ csproj を `Grep` で探す | `SampleApp.UI/SampleApp.UI.csproj` |
| `{{UI_PROJECT_DIR}}` | UI のプロジェクトのフォルダ（`HelpTargets.cs` の場所の基点） | `{{UI_CSPROJ}}` のフォルダ | `SampleApp.UI` |
| `{{DOTNET_MAJOR}}` | .NET の主版（ランタイムなし版の案内） | csproj の `<TargetFramework>`（`net8.0-windows` → `8`） | `8` |
| `{{VERSION}}` | 最初の版（`downloads.json` とマニュアルの改訂履歴） | csproj の `<Version>`。無ければ `1.0.0` を案にし、add-installer で csproj に同じ値を入れる | `1.0.0` |
| `{{TODAY}}` | 今日の日付（`downloads.json` と改訂履歴の最初の行） | `date +%F` | `2026-01-31` |
| `{{GITHUB_REPO}}` | GitHub のリポジトリ（`owner/name`）。手順書の clone 先 | **`git remote get-url origin` から読む**（手で書かない。注意 18） | `owner/SampleApp` |
| `{{SERVER_REPO_DIR}}` | サーバでリポジトリを置くフォルダ（Nginx の root はその下の `web`） | 利用者に聞く。決まっていなければ `/srv/{{SITE_SLUG}}` を案にする | `/srv/sampleapp` |
| `{{SERVER_USER}}` | サーバでリポジトリを持つユーザー | 利用者に聞く。決まっていなければ `deploy` を案にする | `deploy` |

3 本共通の名前のうち、`{{EXE_NAME}}`・`{{ROOT_NAMESPACE}}`・`{{PUBLISHER}}` はこのスキルでは使わない（add-help-window・add-installer が使う）。
**同じ名前には 3 本で同じ値を使う。** 先に入れたスキルの値（`web/downloads.json` のファイル名・`check-web.mjs` の冒頭の設定）を見て合わせる。

## 手順

1. **前提を確かめる**
   - WPF のプロジェクトで、`node` が使える（`node --version`）
   - `web/` がまだ無い。**あれば止めて利用者に聞く**（既存のサイトを上書きしない。apply.mjs も止まる）
   - `git status --short` を見る。触った覚えのない変更は他の作業なので、含めない・消さない
2. **値を集めて確かめる**: 上の表の「どこから読むか」で案を作り、表にして利用者に 1 回で確かめる。
   あわせて「アプリがデータを消す・上書きする操作を持つか」（持つなら `--with-safety`）を聞く
3. **値を JSON に書く**（スクラッチパッドなど、リポジトリの外）。上の表の 15 個をすべて入れる

   ```json
   {"APP_NAME":"SampleApp","TAGLINE":"…","PRICE_TERMS":"…","ACCENT_COLOR":"#5aa2ff",
    "SITE_URL":"https://app.example.com/","SITE_HOST":"app.example.com","SITE_SLUG":"sampleapp",
    "UI_CSPROJ":"SampleApp.UI/SampleApp.UI.csproj","UI_PROJECT_DIR":"SampleApp.UI","DOTNET_MAJOR":"8",
    "VERSION":"1.0.0","TODAY":"2026-01-31","GITHUB_REPO":"owner/SampleApp",
    "SERVER_REPO_DIR":"/srv/sampleapp","SERVER_USER":"deploy"}
   ```

4. **写して置き換える**（まず `--dry-run` で写す先の一覧を見る）

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/skills/add-distribution-site/scripts/apply.mjs" --dest . --values <値の JSON> --dry-run
   node "${CLAUDE_PLUGIN_ROOT}/skills/add-distribution-site/scripts/apply.mjs" --dest . --values <値の JSON> [--with-safety]
   ```

   既にあるファイル（`tools/check-web.mjs` など）は上書きせず「飛ばした」と出る。中身を見て手で合わせる
5. **`.gitignore` に `web/downloads/*.exe` を足す**（インストーラーの実物はリポジトリに入れない。`dist/`・`publish/` は add-installer が足す）
6. **置き換え忘れが無いことを確かめる**

   ```bash
   grep -rnE "\{\{[A-Z0-9_]+\}\}" web tools/check-web.mjs
   ```

   何も出なければよい（apply.mjs も残りがあれば一覧を出して終了コード 1 で終わる）
7. **検査を通す**

   ```bash
   node tools/check-web.mjs
   ```

   この時点の期待は **指摘 0 件**。警告は出てよい: 画像が未配置（撮影前）・雛形の印・F1 の飛び先の表が無い（add-help-window の前）
8. **ブラウザで見る**: `web/index.html` と `web/manual/index.html` をエクスプローラーから開き（`file:///`）、見た目・左の目次・ページ間のリンクを確かめる。
   **`file:///` ではダウンロードのカードと更新履歴は「読み込めませんでした」になる**（ブラウザが `file:///` からの `downloads.json` の取得を止めるため）。中身まで見るなら `web/` でローカルの HTTP サーバを立てる（例: `npx http-server web` か `python -m http.server -d web`）
9. **残りの書き換え箇所を利用者に渡す**: `grep -rn "雛形:" web` の一覧（トップの説明・特長・機能の節など）を示す。サイトの文言は利用者と決めて書く
10. **次の工程を案内する**（ここでは行わない）
    - `/harness-wpf:add-help-window` → `/harness-wpf:add-installer` の順に入れる
    - マニュアルの本文: `/harness-doc:plan-doc`。文書ハーネスが未導入なら `/harness-doc:setup-project` が先。ブリーフの案は `brief-draft.md` を渡す（ブリーフは harness-doc のスクリプトが書くので、このスキルからは書かない）
    - 画面写真: `/harness-wpf:capture-screenshots` で撮り、`web/assets/img/screens/`（アプリにも同梱）に置く。トップの大きな写真は `web/assets/img/site/`（サイト専用。同梱しない）
11. **コミット**はプロジェクトの決まりに従い、置いたファイルをパスで指定する（`git add -A` を使わない）

## 守ること（なぜ込み）

申し送り（2026-11、別の WPF アプリで同じ一式を手で 2 回作った記録）の注意の番号を添える。

- **マニュアルは相対リンクだけで書き、外部の CDN・Web フォント・画像を読まない（注意 13）。** 同じ HTML を配布サイト（`https://`）・ヘルプ窓（WebView2 の仮想ホスト）・`file:///`（インストール完了画面の「はじめに」、WebView2 が無いとき）の 3 通りで開くため。外部を読むと、ネットにつながらない PC のヘルプ窓で崩れる。`check-web.mjs` は `a href` と読み込み（`src`・`link`・CSS の `url()`）を分けて見る
- **マニュアルの中で許す絶対 URL は、配布サイトのトップ（`{{SITE_URL}}`）の 1 つだけ（注意 13）。** 目次の末尾にある。ヘルプ窓では既定のブラウザで開くので、同梱していないページへ迷い込まない。足したいときは `check-web.mjs` の `ALLOWED_ABS` を変える前に、本当に要るかを利用者に聞く
- **サイト専用の画像は `assets/img/site/` に分ける（注意 14）。** add-help-window が `web/assets/**` を `Help\` へ写すときにここを除き、インストーラーを小さくする
- **F1 の飛び先は `HelpTargets.cs` の 1 か所にだけ書き、`check-web.mjs` がそこから拾って実在を見る（注意 15）。** マニュアルの節（`id`）を消したり名前を変えたりすると、F1 が黙って入口に落ちる。表を 2 か所に持つと片方だけ直して食い違うので、検査側に写しを持たない
- **公開の前に、インストーラーの大きさと SHA-256 を `downloads.json` と照合する（注意 16）。** `check-web.mjs --dist dist` がこれを行い、雛形の印が残っていることも指摘にする。publish-release（add-installer）がタグを打つ前に呼ぶ。**作成スクリプトが `downloads.json` を書き換えたのに未コミットなら、公開せずに止める**（書き換え前のまま公開すると、サイトの SHA-256 と実物が食い違う）
- **リポジトリ名などの値は手で書かず、`git remote get-url origin` から読む（注意 18）。** 手で書いた名前が実物と食い違ったことがある
- **画面写真は、別のディスクを `subst` の仮のドライブで作って撮らない（注意 20）。** 仮のドライブは元のディスクと空き容量が同じに写り、読者に「同じディスクに置いている」と読まれる。別のドライブとして見せたいときは、実際に別のドライブ（USB メモリ・VHD）を使う
- **配信の設定（Nginx）では `/deploy/` を返さない。** `web/` をそのまま配るので、手順書（サーバのパスを含む）が外から読めてしまうため
- **差し色は CSS の `--accent` の 1 か所だけで変える。** ほかの色（薄い差し色・枠線・光彩）は `color-mix()` で `--accent` から作っている。値を直に書き足さない

## 受け入れ基準（実機・ブラウザで確かめる）

このスキルを入れた直後:

- [ ] `node tools/check-web.mjs` の指摘が 0 件（相対リンク・外部の読み込みなし・許す絶対 URL は 1 つ・版とファイル名の食い違いなし）
- [ ] `grep -rnE "\{\{[A-Z0-9_]+\}\}" web tools/check-web.mjs` が何も出さない
- [ ] トップ・機能・ダウンロード・更新履歴・マニュアルの各ページが、上部メニューと相互のリンクでたどれる（ブラウザで目視）
- [ ] `web/manual/getting-started.html` と本文 1 ページを `file:///` で開いても、左の目次・ページ間のリンクが使える（目視）
- [ ] 幅 360px（スマートフォン）と 800px（ヘルプ窓の想定）で、横にはみ出さずに読める（ブラウザの開発者ツールで幅を変えて目視）
- [ ] 差し色を 1 か所変えると、ボタン・リンク・ロゴの色がそろって変わる（目視）
- [ ] `web/deploy/` に Nginx の設定例と公開手順書があり、値（ホスト名・パス・リポジトリ名）がこのプロジェクトのものになっている（目視）

サイトの文言とマニュアルを書いた後（公開の前）:

- [ ] トップに、①このアプリが解決すること（1 文）②実画面の写真 1 枚以上 ③特長（データを消すアプリなら安全の約束: 消す前に中身を見せる・戻せる・外部へ送信しない。アプリに実在するものだけ）④価格と利用条件 がある（目視）
- [ ] ダウンロードページに、2 種のインストーラーの違い（迷ったらランタイムあり）・動作環境・アプリとマニュアルが日本語であること・署名なしで SmartScreen の警告が出ることと進め方・各ファイルの SHA-256 がある（目視と、SHA-256 をファイルから計算して照合）
- [ ] `grep -rn "雛形:" web` が何も出さない（`check-web.mjs --dist` でも指摘になる）
- [ ] マニュアルに、F1 の飛び先の表（`HelpTargets.cs`）のページと節がすべてある（`check-web.mjs` の指摘 0 件。add-help-window の後）
- [ ] ビルドの出力に同梱した `Help\` でもリンク切れが無い（`node tools/check-web.mjs --help-dir <出力>/Help`。add-help-window の後）
- [ ] 同じマニュアルのページが、配布サイト（ブラウザ）とヘルプ窓で、同じ見出し・同じ画像で表示される（両方で同じ 3 ページを見比べる）
- [ ] 画面写真に、利用者名・個人のフォルダ名・PC 名が写っていない（`capture-screenshots` のプライバシー検査と目視）
- [ ] 公開の前に `node tools/check-web.mjs --dist dist` の指摘が 0 件（インストーラーの大きさと SHA-256 が `downloads.json` と合う。add-installer の後）

公開した後（利用者の指示で公開したとき）:

- [ ] `curl -s {{SITE_URL}}downloads.json` が最新の `latest` を返し、ダウンロードのボタンでインストーラーが保存される
- [ ] `{{SITE_URL}}deploy/vps-runbook.md` が 404 になる

## やらないこと

- **公開そのもの**（VPS への配置・DNS・証明書・GitHub の Release）。外へ出す操作なので、利用者が指示したときに `web/deploy/vps-runbook.md` に沿って行う
- マニュアルの本文を書くこと（harness-doc の `plan-doc` → `manual-writer` が書く）。ブリーフ（`.claude/rules/doc-brief-*.md`）を直接書くこと
- ヘルプ窓・F1・csproj の同梱設定（add-help-window）、インストーラーと作成・公開スクリプト（add-installer）
- 既にある `web/` やファイルの上書き

## 結果報告

置いたファイルの一覧（apply.mjs の出力）・使った値の表・`check-web.mjs` の結果（指摘と警告の件数）・残っている「雛形:」の箇所・次に入れるスキルを報告する。
