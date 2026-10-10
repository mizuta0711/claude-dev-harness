# tests — 判定ロジックの検査

```bash
node --test
```

**依存パッケージは使わない**（`create-project.mjs` 冒頭の「Node 標準ライブラリのみ」と同じ制約）。
`node:test` と `node:assert` だけで書く。

## なぜ要るのか（R6）

ハーネスの実体は Node スクリプト群で、**判定の中心は正規表現とファイル分類＝純関数**である。
にもかかわらず、2026-08-16 まで検査は `claude plugin validate --strict` だけで、
これは**マニフェストの整合しか見ない**。フックのロジックは1行も検査されていなかった。

`CHANGELOG.md` には「9ケースで判定を確認」「版番号を実際にずらした複製でブロックすることを
確認済み」といった手動確認の記録がある。**確認そのものは丁寧だが、その9ケースはどこにも
残っていなかった。** 次に誰かが判定式を触ったとき、9ケースは守られない。

**このディレクトリは、その9ケースを残す場所である。**

## 何を守っているか

**全 27 本を載せる。** 載っていない行があると、**そのテストは「無いもの」として扱われる** ——
`.gitignore` の自動適用を守る唯一のテストが表から漏れていた（H53-d）。
テストを足したら、ここにも1行足すこと。

### コミット前後の判定（git を見るもの）

| ファイル | 対象 | 守っているもの |
|---------|------|--------------|
| `is-git-commit.test.mjs` | `harness-lib.isGitCommit` | グローバルオプション付き `git commit` の取りこぼし。**unity 側の複製との乖離**も同時に見る |
| `git-scope.test.mjs` | `git-scope`（配布物）と `repo-guard`（このリポジトリ） | コマンド位置の走査。**同じ判定が2箇所にある**ので乖離も見る |
| `repo-guard.test.mjs` | `repo-guard` の判定 | `git add` の範囲指定／`git push` の対象ディレクトリ解決（`cd` は**最後の1つ**） |
| `created-branch-name.test.mjs` | `post-branch-notice.createdBranchName` | 作成形と一覧・削除・改名形の切り分け（除外リストが長い） |
| `pre-commit-check-gates.test.mjs` | `pre-commit-check` | 同じコマンドの中で `git commit` より前にファイルを変える形（H48） |
| `pre-commit-actuality.test.mjs` | `pre-commit-actuality`（**フック本体**） | `gates.docActuality`／対象リポジトリの解決／非 ASCII のパス／**警告が deny に化けないこと** |
| `actuality-scan.test.mjs` | `actuality-scan` | 常時読まれる指示に実態（件数・日付）を書くのを捕まえる判定（H23）。**実物で較正してある** |
| `pre-push-backlog-check.test.mjs` | `pre-push-backlog-check`（**フック本体**） | push の判定／`--dry-run`／`gates.backlogSync: "off"`／deny の出力形式 |
| `backlog-sync.test.mjs` | `backlog-sync` | 台帳と `docs/features/` の整合（H63）。**見逃しも誤検知も実害がある** |

### 危険な操作を止めるもの

| ファイル | 対象 | 守っているもの |
|---------|------|--------------|
| `guarded-command-ask.test.mjs` | `guarded-command-ask`（判定と**フック本体**） | 旧 `permissions.ask` が止めていた形／信頼済み環境／**壊れた config で確認が減らないこと**（H51） |
| `adb-uninstall-guard.test.mjs` | android の `adb uninstall` ガード | **見逃し（データが消える）も誤検知も不可**。両方向を固定する |
| `pre-migrate-backup.test.mjs` | `pre-migrate-backup`（判定と**フック本体**） | `prisma migrate` の実行判定（引用符・ヒアドキュメント）／provider 別の検査（AC1）／**出力が JSON 1つであること** |

### テンプレート追従（harness-update）

| ファイル | 対象 | 守っているもの |
|---------|------|--------------|
| `classify.test.mjs` | `harness-diff.classify` | 3点比較の5分類。**追従の中核で、壊れると無断上書きになる** |
| `never-touch.test.mjs` | `NEVER_TOUCH` / `SEED_ONCE` | 2つの仕掛けの**意味の取り違え**（無断上書き／永久に届かない） |
| `json-merge3.test.mjs` | `mergeJson3` | `.claude/settings.json` のキー単位3方向マージ |
| `text-merge3.test.mjs` | `tryTextMerge` | `.gitignore` の行単位3方向マージ（`git merge-file` に任せる判断ごと） |
| `harness-update-flow.test.mjs` | `analyze` / `apply` / `finalize`（**コマンド本体**） | 分類の配線／`auto-merge` を `merged/` から書くこと／未知の分類の既定拒否／**解決後に analyze をやり直しても `--force` を要求しないこと**（H53-f） |
| `deep-merge.test.mjs` | `create-project.deepMerge` | `settings.json` の合成 |
| `create-project.smoke.test.mjs` | `create-project --dry-run` × 3環境 | **未置換プレースホルダ 0 件**のスモーク |

### 配布物の内部整合（静的検査）

| ファイル | 対象 | 守っているもの |
|---------|------|--------------|
| `wiring.test.mjs` | プラグインの配線 | hooks / skills / agents の参照先が実在すること |
| `duplicated-assets.test.mjs` | **意図的な複製** | プラグインをまたげないため置いた複製が、**片方だけ直る**こと |
| `feature-doc-contract.test.mjs` | スキルの手順と機能設計書テンプレート | 両者の「契約」（節・見出し・台帳の行）のずれ |
| `verification-commands.test.mjs` | `verification.skill` と `permissions` | 動作確認のコマンドが allow に載っていること（H31） |
| `rules-reality-check.test.mjs` | `.claude/rules/` と実物 | `paths` が1件も一致しない（**静かに失敗する**）等（H27） |
| `glob-to-regexp.test.mjs` | `post-edit-lint.globToRegExp` | `paths.source` の一致判定（`**` と `*` の違い） |

### 知らせるだけのもの（壊れても誰も気づかない）

| ファイル | 対象 | 守っているもの |
|---------|------|--------------|
| `audit-notice.test.mjs` | SessionStart の監査通知 | 「監査から N 日」の判定（**止めないので壊れても気づかない**） |
| `milestone-ledger.test.mjs` | SessionStart の台帳通知 | 台帳の「次にやること」を出すこと |

## 書くときの約束

- **失敗したケースを消さない。** 直したらケースを残す（回帰の記録になる）
- **実測で分かったことはケースにする。** CHANGELOG に「〜で確認した」と書くなら、
  同じものをここに置く
- テストのために本体へ `export` を足すのは可。ただし**実行部は
  `require.main === module`（CJS）/ `import.meta.url` 比較（ESM）で囲う**こと。
  囲わないと `require`/`import` した瞬間に stdin を読みに行って固まる
