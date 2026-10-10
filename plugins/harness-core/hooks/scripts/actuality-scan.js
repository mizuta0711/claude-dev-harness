/**
 * **常時読まれる指示に「実態」が書かれていないか**を判定する（H23）。
 *
 * 判定基準の正本は `docs/guide/既存プロジェクト移行指示書.md` §3-5 の表である。
 *
 * | 書きたくなったもの | どうするか |
 * |---|---|
 * | 「〜が N 箇所ある」 | **書かない**（数は `grep` で常に取れる） |
 * | 「〜が N 本ある」 | **書かない**（一覧はファイルシステムが持っている） |
 * | 「YYYY-MM-DD 時点」 | **書きたくなったら、それは実態を書こうとしている合図** |
 *
 * **なぜ機械で見るのか。** これは **H9 → H23 の再発**で、
 * **「指示書に名指しで警告する」では守られなかった**。
 *
 * > 実測（WPF の実プロジェクト・2026-08-16）: **「件数と日付を書かない」を判定基準にして 2,336行を削った
 * > その同じ作業で**、`.claude/rules/xaml-ui.md` の注記に「2026-08-16 の棚卸しで確認」を2回と
 * > 「`x:Key="Spacing*"` は0件」を書いていた。**検出したのは査読で、自己点検では出ていない。**
 *
 * **書いている本人には「実態」に見えない。** 日付と件数を**証拠**として書いており、
 * 「実態のスナップショットを書いている」自覚が無い。
 * **「気をつける」で守る対策は、書いた本人が次に破る**（H19 と同じ結論）。
 *
 * **deny にしない。** 完全な判定は無理で、正しく件数を書く場面もある
 * （改訂履歴・数えた範囲を併記した実測）。**黙らせないことが目的**である（H16 の教訓）。
 */

/**
 * 検査の対象になるパスか。
 *
 * **常時読まれる指示に限る。** `docs/reviews/` の実測記録は**件数を書くのが正しい**ので、
 * 同じ基準を当ててはいけない。
 */
function isWatchedPath(rel) {
  // git の出力はつねに `/` 区切りなので、正規化は要らない
  const p = String(rel || "");
  if (p.startsWith("docs/")) return false;
  // **`environment.md` は実態を書く場所である**（H55。スタックの実際の版・構成・固有の注意点）。
  // ハーネスが「プロジェクト所有・配り切り」と決めた唯一の常時ファイルなので、
  // ここに同じ基準を当ててはいけない（実測: 「WPF アプリが3本ある」等で鳴った）。
  if (p.endsWith(".claude/harness/environment.md")) return false;
  return (
    p === "CLAUDE.md" ||
    p === "constitution.md" ||
    (p.startsWith(".claude/") && p.endsWith(".md"))
  );
}

/**
 * 改訂履歴の行か。
 *
 * **除外する。** 「6→7値に増えた」のような記述は**変更内容の説明**であって、
 * 実態のスナップショットではない。表の1列目が版番号（`1.2` / `3.15`）の行で見分ける。
 */
function isHistoryRow(line) {
  return /^\s*\|\s*\**\d+\.\d+\**\s*\|/.test(line);
}

/** コードスパンの中身は判定しない（例示で件数を書くことがある） */
function stripCode(line) {
  return line.replace(/`[^`]*`/g, "``");
}

/**
 * 判定しない行か。
 *
 * **実物で較正した結果の除外である**（テンプレートの指示文書に当てて残った誤検出）。
 *
 * | 除外 | 理由 |
 * |---|---|
 * | **HTML コメント** | **書く人への注記**であって、読ませる指示ではない（「この2行を消すと全部読まれなくなる」等） |
 * | **引用（`>`）** | **実測の引用＝根拠**である。指示書 §3-5 自身が「件数を書くなら数えた範囲を併記する」と認めている（「実測（2026-08-17）: …14箇所で使っていた」等） |
 * | **表の区切り行** | 記号だけ |
 *
 * **引用を外すのは取りこぼしを増やす方向である。** それでも外すのは、
 * **鳴りすぎる安全弁は外される**（R3）ほうが害が大きいから。
 */
function isSkippedLine(line) {
  const t = line.trim();
  if (!t) return true;
  if (t.startsWith("<!--") || t.endsWith("-->") || t.startsWith("-->")) return true;
  if (t.startsWith(">")) return true;
  if (/^\|[-:\s|]+\|?$/.test(t)) return true;
  return false;
}

/**
 * **判定は実物で較正してある。**
 *
 * 指示書 §3-5 の表を字面どおり正規表現にすると**使えない**。
 * テンプレートの指示文書に当てた初版は **56行**に当たり、ほぼ全部が誤検出だった ——
 * 「**1箇所**に集約する」「**1行**残す」「一度に編集するファイルは**最大5ファイル**」
 * 「**1件**ずつ取得せず」のように、**数は方針の言い方として日常的に出てくる**。
 *
 * **実態と方針を分けるのは「数」ではなく「存在を述べているか」である。**
 *   - 実態 … 「26本**すべてが** kebab-case」「14箇所で**使っていた**」「`Spacing*` は**0件**」
 *   - 方針 … 「1箇所に**集約する**」「**最大**5ファイル」「1行**残す**」
 *
 * **鳴りすぎる安全弁は外される**（R3）。**誤検出を削る方へ倒してある**ので、
 * **取りこぼしはある**。これは査読の代わりではなく、査読まで残りやすい型を1つ減らす仕掛けである。
 */
const PATTERNS = [
  {
    name: "日付つきの但し書き",
    // ISO と**年月日表記**の両方を見る。日本語の文書では「2026年8月16日時点」が自然に出る（査読 中3）
    re: /(?:\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?|\d{4}年\d{1,2}月(?:\d{1,2}日)?)\s*(?:時点|現在|の(?:棚卸し|調査|実測|確認|点検)|確認済み|確認した)/,
    why: "**書きたくなったら、それは実態を書こうとしている合図**（指示書 §3-5）。但し書きごと消す。",
  },
  {
    name: "存在の件数",
    // 数＋単位の後ろに**存在を述べる言葉**が続くものだけ。
    // 単位は「個・画面」まで広げた（査読 中3。「26個のファイル」「10画面ある」）。
    // **「つ」は入れない** —— 日本語の散文でいちばん汎用の助数詞で、
    // 「決まりが3つある」「手作業が1つ残る」のような**方針の説明に当たってしまう**（実測）。
    // **「N件ずつ」は様態**なので外す（「1件ずつ使用して」。査読 中1）
    re: /\d+\s*(?:箇所|ファイル|本|件|行|個|画面)(?!ずつ)[^。\n]{0,14}?(?:すべて|全て|ある(?:[。、）」]|$)|あった|あり、|あります|存在|残って|残る|見つか|違反|使って|使用して|確認済み|確認した)/,
    why: "**数は `grep` とファイルシステムが常に持っている**（指示書 §3-5）。数を消して、方針だけ残す。",
  },
  {
    name: "ゼロ件の主張",
    re: /(?:^|[^\d])0\s*(?:件|箇所|本)/,
    why: "**「今は無い」は実態である**（指示書 §3-5）。無いことが前提の方針なら、方針として書く。",
  },
  {
    name: "現在の件数",
    // 「現在 14 件」「全14ファイル」（査読 中3）
    // **「全N〈単位〉」は単独では鳴らさない。** 「全5画面を対象にする」「全3ファイルを
    // 同時に更新する」のような**方針の言い方で鳴っていた**（査読 低2）。
    // 存在を述べる「全14ファイルに残っている」は上の「存在の件数」が拾う。
    re: /現在\s*\d+\s*(?:件|箇所|本|ファイル|個|画面)/,
    why: "**数は `grep` とファイルシステムが常に持っている**（指示書 §3-5）。",
  },
];

/**
 * 条件・仮定の文か。**外す。**
 *
 * **これは実態ではなく方針である** —— 「違反が**1件でも**見つかっ**たら**直す」
 * 「同じ処理が**3箇所に**残ってい**たら**共通化する」「**0件になるまで**直す」。
 * 初版はこれらで鳴り、**判定が語彙の偶然に依存していた**
 * （「1件ずつ取得せず」は鳴らないのに「1件ずつ使用して」は鳴る、という状態だった。査読 中1）。
 */
function isConditional(line) {
  return /(?:たら|なら|れば|ならば|場合|とき|以上|未満|以下|超え|まで|でも)/.test(line);
}

/**
 * 1行を判定する。
 *
 * @returns {{name: string, why: string}[]} 当たったパターン（空配列なら問題なし）
 */
function scanLine(line) {
  if (isSkippedLine(line) || isHistoryRow(line) || isConditional(line)) return [];
  const text = stripCode(line);
  return PATTERNS.filter((p) => p.re.test(text)).map(({ name, why }) => ({ name, why }));
}

/**
 * **ファイル全体を状態つきで検査する。**
 *
 * **`scanLine` だけでは足りない。** `isSkippedLine` は1行しか見ないので、
 * **複数行にわたる HTML コメントとコードフェンスの中身が検査されてしまう**（査読 中2）。
 * `git diff -U0` には文脈が無いため、**ファイルを読まないと範囲が分からない**。
 *
 * > 実測: `templates/nextjs/.claude/rules/typescript.md` の「26本すべてが kebab-case」は
 * > **複数行の HTML コメントの中**にあり、「本物の実態」ではなく**除外の取りこぼし**だった。
 *
 * @returns {{lineNo: number, line: string, hits: {name: string, why: string}[]}[]}
 */
function scanText(content) {
  const out = [];
  let inFence = false;
  let inComment = false;
  const lines = String(content || "").replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (/^(```|~~~)/.test(t)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (inComment) {
      const close = t.lastIndexOf("-->");
      if (close < 0) continue;
      inComment = t.indexOf("<!--", close) >= 0;
      continue;
    }
    {
      const open = t.lastIndexOf("<!--");
      if (open >= 0 && t.indexOf("-->", open) < 0) {
        inComment = true;
        continue;
      }
    }

    const hits = scanLine(line);
    if (hits.length) out.push({ lineNo: i + 1, line, hits });
  }
  return out;
}

/**
 * `git diff` の出力から、**追加行だけ**を検査する。
 *
 * **消す側ではなく書き直す側を見るのが目的**なので、追加行に限る。
 *
 * @param {string} diff `git diff --cached -U0` 等の出力
 * @returns {{file: string, line: string, hits: {name: string, why: string}[]}[]}
 */
function scanDiff(diff) {
  const out = [];
  let file = null;
  for (const raw of String(diff || "").replace(/\r\n/g, "\n").split("\n")) {
    const m = /^\+\+\+ (?:b\/)?(.+)$/.exec(raw);
    if (m) {
      const name = m[1].trim();
      file = name === "/dev/null" ? null : name;
      continue;
    }
    if (!file || !raw.startsWith("+") || raw.startsWith("+++")) continue;
    if (!isWatchedPath(file)) continue;
    const line = raw.slice(1);
    const hits = scanLine(line);
    if (hits.length) out.push({ file, line: line.trim(), hits });
  }
  return out;
}

module.exports = { scanDiff, scanLine, scanText, isWatchedPath, isHistoryRow, isSkippedLine, isConditional, PATTERNS };
