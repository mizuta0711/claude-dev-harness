# permissions ベースライン（Phase 2 の `settings.json` 雛形が実装する方針）

| 項目 | 内容 |
|------|------|
| 位置づけ | **設計記録**。この文書自体は動作しない。Phase 2 の `templates/base` / `templates/<env>` の `.claude/settings.json` 雛形が実装する |
| 根拠 | Phase 0 の発見事項 F1〜F3・F7 と、レビュー追加発見 R2・R3・R5（ProjectTemplete `docs/reviews/20260814_094949_phase0-fixes_レビュー.md`） |
| 裏取り | Claude Code 公式ドキュメント（permissions / settings / mcp / skills）で確認済み。コロンなしワイルドカード（`Bash(rm -rf *)`）は有効、`Read()` の deny は Bash の `cat`/`head`/`tail`/`sed` にも波及する |
| 実機検証 | **2026-08-14 に §5 の全項目を実測済み**（Claude Code 2.1.220 / headless `claude -p` + `--output-format json` の `permission_denials`）。§2 は実測結果を反映した形になっている |

## 1. 層の分離（F1）

| ファイル | Git 管理 | 置くもの |
|---------|---------|---------|
| `.claude/settings.json` | **する**（テンプレート・派生プロジェクトへ伝播） | **deny 全部**、共有すべき allow / ask、hooks、`enabledPlugins` |
| `.claude/settings.local.json` | しない（`.gitignore`） | 手元だけの allow（個人の作業効率化）、個人的な env |

**原則: セキュリティに関わる設定を `*.local.json` に置かない。** 共有されないため派生プロジェクトが無防備になる。

## 2. deny のベースライン

```jsonc
{
  "permissions": {
    "deny": [
      // 秘密情報の読み書き
      //   `Edit(path)` はファイル編集ツール全般（Write / NotebookEdit 等）を覆う。
      //   `Write(path)` はファイル権限チェックの対象外で、書いても効かないうえ
      //   起動時に警告が出る（C1 の初回起動で実際に出た。§5-6 参照）
      //
      //   ⚠️ ここだけ R5（ワイルドカード優先）の**例外**として列挙している。
      //   `.env*` だと `.env.example` まで塞いでしまい、`.gitignore` の `!.env.example`
      //   （＝コミット対象）と矛盾する。deny はツール層で「今回だけ許可」ができないため、
      //   シェル経由の迂回を誘発する（§5-7）。実際に秘密を持つファイルだけを列挙する
      "Read(./.env)",
      "Read(./.env.local)",
      "Read(./.env.development)",
      "Read(./.env.development.local)",
      "Read(./.env.production)",
      "Read(./.env.production.local)",
      "Read(./.env.test)",
      "Read(./.env.test.local)",
      "Read(./secrets/**)",
      "Edit(./.env)",
      "Edit(./.env.local)",
      "Edit(./.env.development)",
      "Edit(./.env.development.local)",
      "Edit(./.env.production)",
      "Edit(./.env.production.local)",
      "Edit(./.env.test)",
      "Edit(./.env.test.local)",

      // Read deny が波及しない経路を塞ぐ（R3）
      //   公式に波及が明記されているのは cat / head / tail / sed。
      //   grep / Select-String / type などは明記が無いため個別に塞ぐ
      "Bash(grep * .env*)",
      "Bash(rg * .env*)",
      "PowerShell(Select-String*.env*)",
      "PowerShell(Get-Content*.env*)",

      // 破壊的削除
      //   実測: "Bash(rm -rf *)" は `rm -fr` / `rm -r` / `rm --recursive` を取りこぼす（§5-4）。
      //   フラグの綴りごとに列挙する形へ書き直した。`rm plain.txt` は通る
      "Bash(rm -r*)",
      "Bash(rm -f*)",
      "Bash(rm --recursive*)",
      "Bash(rm --force*)",
      "PowerShell(Remove-Item*-Recurse*)",   // F2: 引数順序に依存しない形にする

      // force push（F3: refspec 形式も塞ぐ）
      "Bash(git push --force*)",
      "Bash(git push -f *)",
      "Bash(git push * +*)",
      "PowerShell(git push --force*)",
      "PowerShell(git push -f *)",
      "PowerShell(git push * +*)"
    ]
  }
}
```

## 3. ask のベースライン（F7・R2）

`git push` は**テンプレート既定では allow にしない**。無確認の push は事故が戻しにくい。

```jsonc
{
  "permissions": {
    "ask": [
      "Bash(git push:*)",
      "PowerShell(git push:*)",
      "Bash(git reset:*)",
      "Bash(git checkout:*)",
      "Bash(git clean:*)"
    ]
  }
}
```

## 4. allow の方針

- 読み取り系（`Read` / `Glob` / `Grep`）と、破壊的でない git 参照系（`status` / `diff` / `log` / `show` / `branch`）
- 環境ごとのビルド・チェックコマンドは **`harness.config.json` の `commands` に書かれたものと一致させる**
  （config で実行するコマンドが allow に無いと、hook 経由の実行で毎回確認が入る）
- 個人の趣味に属するもの（エディタ起動、雑多な CLI）は `settings.local.json` へ

## 5. 実測結果（2026-08-14）

Phase 2 T0 で実施。検証方法は scratchpad に使い捨てプロジェクト（`git init` + 検証対象の deny のみを書いた
`.claude/settings.json`）を作り、`claude -p --allowedTools ... --output-format json` で該当コマンドを
実行させ、返却 JSON の `permission_denials` 配列（拒否されたツール呼び出しが記録される）と
**副作用の有無（ディレクトリが実際に消えたか）** の両方で判定した。
モデルの自己申告ではなく機械的な記録で判定している点が要点。

| # | パターン | 拒否されるべき操作 | 結果 | 通るべき操作 | 結果 |
|---|---------|------------------|------|-------------|------|
| 1 | `Bash(grep * .env*)` / `Bash(rg * .env*)` | `grep SECRET .env.local` / `rg SECRET .env` | ✅ 両方 deny | `grep TODO src/index.ts` | ✅ 実行された |
| 2 | `PowerShell(Remove-Item*-Recurse*)` | `Remove-Item -Recurse -Force dirA` / `Remove-Item dirB -Recurse -Force`（引数順の入替） | ✅ 両方 deny | `Remove-Item single-file.txt` | ✅ 実行された |
| 3 | `Bash(git push * +*)` ほか force push 3種 | `git push origin +main` / `git push --force origin main` / `git push -f origin main` | ✅ 3件とも deny | `git push origin main` | ✅ 実行された（deny されない） |

**結論: §5 の未検証3項目はいずれも設計どおり機能した。書き直しは不要。**
中間位置のワイルドカード（`grep * .env*`）も、末尾の ` *`（空白+アスタリスク）も期待どおり動作する。

### 5-4. 追加検証で見つかった要修正（§2 に反映済み）

未検証3項目のついでに §2 の残りも実測したところ、**`Bash(rm -rf *)` に取りこぼしがあった**。

| コマンド | `Bash(rm -rf *)` での結果 |
|---------|--------------------------|
| `rm -rf d1` | ✅ deny（ディレクトリ残存） |
| `rm -fr d2` | ❌ **実行された**（ディレクトリ消失） |

`rm` はフラグを1トークンに結合するため、`PowerShell(Remove-Item*-Recurse*)` のような
中間ワイルドカードによる順序非依存化が使えない。フラグの綴りごとに列挙する形へ書き直した:

| 書き直し後のパターン群 | `rm -rf` | `rm -fr` | `rm -r` | `rm --recursive --force` | `rm plain.txt` |
|----------------------|---------|---------|--------|--------------------------|----------------|
| `Bash(rm -r*)` + `Bash(rm -f*)` + `Bash(rm --recursive*)` + `Bash(rm --force*)` | ✅ deny | ✅ deny | ✅ deny | ✅ deny | ✅ 通る |

副作用でも確認済み（a1〜a4 は残存、plain.txt のみ消失）。
`rm -f single-file.txt` も deny されるが、これは意図した挙動として受け入れる
（単純な `rm file` は通るため、通常のファイル削除は妨げない）。

### 5-5. 残余リスク

- `Bash` の deny はコマンド文字列のパターン照合であり、`bash -c 'rm -fr x'`・エイリアス・
  スクリプト経由の間接実行までは塞げない。**deny は事故防止であって攻撃対策ではない**
- `PowerShell(Remove-Item*-Recurse*)` は `ri -r`（別名+短縮フラグ）を塞がない。
  同様に列挙で塞ぐこともできるが、別名の網羅は現実的でないため未対応とする

### 5-6. `Write(path)` は deny に書いても効かない（C1 の初回起動で発覚・2026-08-14）

生成直後の `bookmark-app` で `claude` を起動したところ、初回に次の警告が出た:

```
Permission deny rule (.claude\settings.json): Write(./.env*) is not matched by file permission checks
— only Edit(path) rules are. Use Edit(./.env*) instead (Edit rules cover all file-editing tools).
```

**ファイルパス指定の権限チェックは `Edit(path)` だけが対象**で、`Edit` ルールが Write を含む
編集系ツール全般を覆う。`Write(path)` は照合されないため、書いても保護にならない。

幸い `Edit(./.env*)` が既にあったため**保護に穴は無かった**が、
`Write(./.env*)` は無効なうえ毎回警告を出すため削除した（§2 に反映済み）。

> **これは実プロジェクトに適用して初めて出た指摘**である。テンプレートの静的レビューでは
> 「Edit と Write の両方を塞いでいる」と読めてしまい、誤りに見えなかった。
> C1（ドッグフーディング）を先に通すべきという判断の正しさを示す最初の実例。

### 5-7. `.env*` の deny が `.env.example` を巻き込んでいた（C1 1周目で発覚・2026-08-14）

`Read(./.env*)` / `Edit(./.env*)` は **`.env.example` にも一致する**。
しかし `.gitignore` は `!.env.example` で明示的にコミット対象にしており、**矛盾していた**。

実害:

- **AI が `.env.example` を読めない** — どの環境変数が必要かをテンプレートから知る手段が塞がれる
- **AI が `.env.example` を作れない・更新できない** — 環境変数を増やしたときに雛形が腐る
- deny はツール層で「今回だけ許可」ができないため、**シェル経由の迂回**（`cat` 等）が発生した。
  迂回が常態化すると deny 自体が形骸化する

**対応**: `.env*` のワイルドカードをやめ、**実際に秘密を持つファイルだけを列挙**した（§2）。
`.env.example` / `.env.sample` は対象外になる。

> **R5（列挙ではなくワイルドカード）に対する意図的な例外**である。
> R5 の狙いは「変種の取りこぼしを防ぐ」ことだが、ここでは逆に
> **取りこぼしてはいけないものと、塞いではいけないものが同じ接頭辞を共有している**。
> 両立できないため、塞ぐ対象を明示する側を選んだ。

**残余リスク**: `.env.staging` のような**列挙外の命名**は deny をすり抜ける。
プロジェクトで独自の環境名を使う場合は `.claude/settings.json` に追加すること。
なお `Bash(grep * .env*)` 等のシェル迂回対策は**ワイルドカードのまま残している**
（`.env.example` を grep できない不便より、秘密の漏れを塞ぐ方を優先した）。

### 5-8. `prisma migrate reset` の deny がフックより手前で効いていた（C1 2周目で発覚・2026-08-15）

`templates/nextjs/.claude/settings.json` は `Bash(*prisma migrate reset*)` を **deny** していた。
一方でハーネスは `pre-migrate-backup` フックを持ち、migrate の前に必ずバックアップを取る設計である。

**deny はフックより手前で効くため、フックが仕事をする機会が無かった。**
C1 2周目で `migrate reset` が拒否されたとき、`.bak` は1つも増えなかった（実測）。

さらに3つの問題があった:

1. **ハーネス自身の手順と衝突していた。** 設計書の前提条件が `npx prisma migrate reset` を
   指示しているのに、同じハーネスの権限ベースラインがそれを禁じていた
2. **deny は「今回だけ許可」ができない**ため、`rm` で DB を消して `migrate deploy` で
   作り直すという**迂回案**が実際に提示された（#9 と同じ構図）
3. **ワイルドカードが脆い。** `*prisma migrate reset*` はコミットメッセージ本文に
   その文字列が含まれるだけでマッチする。**`pre-migrate-backup.js` は同じ理由でこの方式をやめた**のに、
   権限側には残っていた

**対応**: `deny` から外した。既存の `ask("Bash(*prisma migrate*)")` が reset も覆うため、
**ユーザーの明示的な承認 + フックによるバックアップ**という二段の安全が正しく働く。

> deny のままだと安全になるどころか、**迂回か手動実行を強いて安全網を外す方向**に働いていた。
> §5-6 / §5-7 と同じく「安全側に倒したつもりが安全性を損なう」型の不具合である。
