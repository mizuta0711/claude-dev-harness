import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * スキルの手順と機能設計書テンプレートの「契約」の静的検査
 *
 * ## なぜ要るのか
 *
 * スキルの手順（SKILL.md）は、機能設計書の**節名**と**メタ情報のステータス値**を名指しして
 * 「ここを読む」「ここに書く」と指示する。**名指しした先が TEMPLATE.md に無いと、
 * スキルは空振りするか、番号が近い別の節を読みにいく。**
 *
 * 0.23.0（Stage 2 をフェーズごとに書く）の初版で、これが実際に3件起きた:
 *
 * | 欠陥 | 内容 |
 * |---|---|
 * | 実在しない節を指した | 手順が「`4-2` 共通の約束」と書いたが、TEMPLATE の `4-2` は「インターフェース仕様」 |
 * | 実在しない節にデータを求めた | 検査が「フェーズの節に書かれた変更ファイル」を見ると書いたが、TEMPLATE は変更ファイルを共通の1表に持つ |
 * | 凡例に無い値を書かせた | 手順が `🔵 Phase {n} まで確定` を要求したが、TEMPLATE の凡例は閉じた集合だった |
 *
 * **3件とも独立査読が見つけた。** 読めば分かるが読まないと分からない種類なので、機械に任せる。
 * `wiring.test.mjs` の「H24: 宣言と実装がずれる」と同じ系統である。
 */

const TEMPLATE_PATH = "plugins/harness-core/skills/new-feature/TEMPLATE.md";
const template = fs.readFileSync(path.join(ROOT, TEMPLATE_PATH), "utf-8");

/** 機能設計書を読み書きするスキル（TEMPLATE の節名・ステータス値を名指しするもの） */
const SKILLS = [
  "plugins/harness-core/skills/design-review/SKILL.md",
  "plugins/harness-core/skills/complete-feature/SKILL.md",
  "plugins/harness-core/skills/new-feature/SKILL.md",
  "plugins/harness-core/skills/new-feature/開発フローと規模判定.md",
  // **試作も同じ TEMPLATE を使う**（専用の雛形は作らない）。
  // `new-prototype` は「`🔵 Phase {n} まで確定` を使わない」と TEMPLATE の値を名指しするので、
  // **ここに載せないと TEMPLATE 側が変わっても検査が効かない**（0.39.0 の査読が指摘した）。
  "plugins/harness-core/skills/new-prototype/SKILL.md",
  // **受け入れ基準の節を名指しする側**（0.41.0 で M でも必須にしたときの査読が指摘した）。
  // 載せないと「Stage 1 の受け入れ基準」のような**規模を取り違えた記述が黙って残る**。
  "plugins/harness-core/skills/sync-check/SKILL.md",
  "plugins/harness-core/skills/update-docs/SKILL.md",
  "plugins/harness-core/agents/code-reviewer.md",
  // **「推奨で決めた判断」を設計書から拾う側と、「作成・変更ファイル」を実装後に書く側**（0.42.0 の査読が指摘した）。
  // どちらも節名・印を名指しするので、TEMPLATE 側が変わったら気づけるようにする。
  "plugins/harness-core/skills/done/SKILL.md",
  "plugins/harness-core/skills/code-review/SKILL.md",
];

const NL = String.fromCharCode(10);

/** TEMPLATE の見出し（### / ####）の本文部分 */
const templateHeadings = template
  .split(NL)
  .filter((l) => /^#{3,4} /.test(l))
  .map((l) => l.replace(/^#{3,4} /, "").trim());

/** 番号 → 節名 */
const byNumber = new Map();
for (const h of templateHeadings) {
  const m = h.match(/^(\d+-\d+)\.\s*(.+)$/);
  if (m) byNumber.set(m[1], m[2].trim());
}

/**
 * スキルの手順書は**自分自身も** 3-1 / 4-2 の番号で節を切っている
 * （例: 開発フローと規模判定.md の `### 4-2. Stage 2: 技術設計`）。
 * それは機能設計書の節ではないので、見出し行は走査しない。
 */
const proseOf = (text) =>
  text
    .split(NL)
    // 行頭（字下げなし）の見出しだけを除く。**字下げされた `### 4-2. …` は残す** —
    // そちらは節構成の説明や例示で、まさに実物とずれる場所である（0.23.0 初版の欠陥がこれ）。
    .filter((l) => !/^#{1,6} /.test(l))
    // バッククォートで囲んだ span は除く。「`### 3-3. 未解決事項` でも `### 3-2. 未解決事項`
    // でも同じ節」のように、**番号が揺れることの説明**で意図的に別名を並べる箇所があるため。
    .map((l) => l.replace(/`[^`]*`/g, "``"))
    .join(NL);

test("スキルが名指しする機能設計書の節番号は、TEMPLATE.md に同じ番号の見出しがある", () => {
  assert.ok(byNumber.size >= 5, `TEMPLATE から節番号が拾えていない: ${[...byNumber.keys()]}`);

  const missing = [];
  for (const rel of SKILLS) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf-8");
    for (const m of text.matchAll(/`(\d+-\d+)`/g)) {
      if (!byNumber.has(m[1])) missing.push(`${rel}: \`${m[1]}\``);
    }
  }
  assert.deepEqual(missing, [], `TEMPLATE.md に無い節番号を名指ししている:${NL}${missing.join(NL)}`);
});

test("同じ節番号が、スキルの散文と TEMPLATE で別の節を指していない", () => {
  const conflicts = [];
  // TEMPLATE 自身も対象にする。節構成の説明が自分の見出しとずれるのが 0.23.0 初版の欠陥だった。
  for (const rel of [...SKILLS, TEMPLATE_PATH]) {
    const prose = proseOf(fs.readFileSync(path.join(ROOT, rel), "utf-8"));
    for (const m of prose.matchAll(/(?:^|[\s`])(\d+-\d+)\.\s+([^\n|`、。（(]{2,30})/gm)) {
      const [, num, name] = m;
      const expected = byNumber.get(num);
      if (!expected) continue;
      const got = name.trim();
      // 節名を含んでいれば一致とみなす（前後に説明が付く形を許す）
      if (!got.startsWith(expected) && !expected.startsWith(got)) {
        conflicts.push(`${rel}: \`${num}\` を「${got}」と書いているが、TEMPLATE は「${expected}」`);
      }
    }
  }
  assert.deepEqual(conflicts, [], `節番号の意味がずれている:${NL}${conflicts.join(NL)}`);
});

test("スキルが設計書へ書かせる印は、TEMPLATE.md の凡例に載っている", () => {
  const legend = template.slice(0, template.indexOf("## 1. 概要"));
  // ⏸️ は U+23F8 + 異体字セレクタ(U+FE0F)。文字クラスに入れると半分だけ一致するので、
  // セレクタは任意で許し、比較の前に落とす。
  const MARK = "[\u{1F535}\u{1F7E1}\u{1F7E2}\u2705\u23F8\u274C\u26AA]\uFE0F?";
  const norm = (x) => x.replace(/\uFE0F/gu, "").replace(/\s+/gu, " ").trim();

  const values = new Set();
  const legendRe = new RegExp(`(${MARK})\s*([^${NL}|/\u2014]+?)(?=\s*(?:[\u2014/|]|$))`, "gmu");
  for (const m of legend.matchAll(legendRe)) values.add(norm(`${m[1]} ${m[2]}`));
  assert.ok(values.size >= 10, `凡例から値が拾えていない: ${[...values]}`);

  const unknown = [];
  const useRe = new RegExp(`\`(${MARK})\s*([^\`]{1,40})\``, "gu");
  // `done` は**完了報告の表の印**（`✅ /{skill} を実施…` 等）をコードスパンで持つ。設計書へ書かせる印ではないので
  // この検査だけ外す（節番号の2検査は効かせる）。拾い先の `AI 推奨` は印を伴わない文字列で名指ししている。
  const REPORT_ONLY = new Set(["plugins/harness-core/skills/done/SKILL.md"]);
  for (const rel of SKILLS.filter((r) => !REPORT_ONLY.has(r))) {
    const text = fs.readFileSync(path.join(ROOT, rel), "utf-8");
    // バッククォートで囲まれた「印 + 語」だけを対象にする（散文の飾りを拾わない）
    for (const m of text.matchAll(useRe)) {
      const got = norm(`${m[1]} ${m[2]}`);
      if (![...values].some((v) => got.startsWith(v) || v.startsWith(got))) {
        unknown.push(`${rel}: \`${got}\``);
      }
    }
  }
  assert.deepEqual(unknown, [], `TEMPLATE.md の凡例に無い印を書かせている:${NL}${unknown.join(NL)}`);
});

test("「規模: L のみ」の印は TEMPLATE の5節の見出し直下にあり、new-feature の記述と一致する", () => {
  // **M の最小形は印で節を落とす**（0.42.0）。印が見出しから離れる・数が変わる・new-feature の列挙とずれると、
  // M の設計書に残るべき節が落ちるか、落とすべき節が残る。どちらも読まないと気づけない。
  const MARKER = "<!-- 規模: L のみ。M では生成しない -->";
  const lines = template.split(NL);

  const markerLines = lines.map((l, i) => [l.trim(), i]).filter(([l]) => l === MARKER).map(([, i]) => i);
  const marked = [];
  for (const i of markerLines) {
    const prev = lines[i - 1] ?? "";
    assert.match(prev, /^#{2,3} /, `印が見出しの直下に無い（${i + 1} 行目。直前: ${prev}）`);
    marked.push(prev.replace(/^#{2,3} /, "").trim());
  }
  assert.deepEqual(marked, [
    "2. タスク一覧",
    "3-4. Stage 1 レビュー記録",
    "5. 動作確認計画",
    "6. 関連ドキュメント",
    "7. 注意事項",
  ]);

  // new-feature の「同梱版では「…」「…」…の N つ」と、TEMPLATE の印の付いた節名を突き合わせる
  const skill = fs.readFileSync(path.join(ROOT, "plugins/harness-core/skills/new-feature/SKILL.md"), "utf-8");
  const m = skill.match(/同梱版では((?:「[^」]+」)+)の(\d+)つ/);
  assert.ok(m, "new-feature/SKILL.md に「同梱版では「…」…の N つ」の列挙が無い");
  const named = [...m[1].matchAll(/「([^」]+)」/g)].map((x) => x[1]);
  assert.equal(Number(m[2]), named.length, "new-feature の列挙の数と「N つ」が食い違う");
  assert.deepEqual(
    named,
    marked.map((h) => h.replace(/^\d+(?:-\d+)?\.\s*/, "")),
    "new-feature が列挙する節と、TEMPLATE で印の付いた節が食い違う",
  );
});
