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

| ファイル | 対象 | 守っているもの |
|---------|------|--------------|
| `is-git-commit.test.mjs` | `harness-lib.isGitCommit` | グローバルオプション付き `git commit` の取りこぼし。**unity 側の複製との乖離**も同時に見る |
| `created-branch-name.test.mjs` | `post-branch-notice.createdBranchName` | 作成形と一覧・削除・改名形の切り分け（除外リストが長い） |
| `repo-guard.test.mjs` | `repo-guard` の判定 | `git add` の範囲指定／`git push` の対象ディレクトリ解決（`cd` は**最後の1つ**） |
| `classify.test.mjs` | `harness-diff.classify` | 3点比較の5分類。**追従の中核で、壊れると無断上書きになる** |
| `deep-merge.test.mjs` | `create-project.deepMerge` | `settings.json` の合成 |
| `glob-to-regexp.test.mjs` | `post-edit-lint.globToRegExp` | `paths.source` の一致判定（`**` と `*` の違い） |
| `create-project.smoke.test.mjs` | `create-project --dry-run` × 3環境 | **未置換プレースホルダ 0 件**のスモーク |

## 書くときの約束

- **失敗したケースを消さない。** 直したらケースを残す（回帰の記録になる）
- **実測で分かったことはケースにする。** CHANGELOG に「〜で確認した」と書くなら、
  同じものをここに置く
- テストのために本体へ `export` を足すのは可。ただし**実行部は
  `require.main === module`（CJS）/ `import.meta.url` 比較（ESM）で囲う**こと。
  囲わないと `require`/`import` した瞬間に stdin を読みに行って固まる
