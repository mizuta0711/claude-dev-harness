import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 配布物が「内部で整合しているか」の静的検査
 *
 * ## なぜ要るのか
 *
 * 利用実績の監査（ProjectTemplete `docs/reviews/20260817_仕組み自体の要否監査.md`）で、
 * **配ったのに一度も動かないもの**が実測で見つかった。原因は2種類あり、どちらも静的に検出できる:
 *
 * | 欠陥 | 実例 |
 * |---|---|
 * | **H25: 呼び出し導線が無い** | `coding-specialist` が 2026-04-04 の追加以来0回。呼び出しは1箇所だけで、しかも**コメントブロックの中**にあった |
 * | **H24: 宣言と実装がずれる** | 「`/sync-check` は `/update-docs` の完了時に**自動実行**」と書いてあったが、**自動実行する実装は無かった** |
 *
 * どちらも「動かなくても何も起きない」ので、**実測するまで4ヶ月気づかなかった**。
 *
 * ## ⚠️ コメントブロックの中は「呼び出し」と認めない
 *
 * これがこの検査の要点である。`coding-specialist` の唯一の呼び出しは
 * `<!-- この設計書の運用フロー（作成後、このセクションは削除してよい）: -->` の中にあった。
 * **素朴に grep すると「配線あり」と誤判定する。**
 */

// ---------------------------------------------------------------------------
// 収集
// ---------------------------------------------------------------------------

const listDirs = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : [];
};

const PLUGINS = listDirs("plugins");

/** @returns {{plugin:string,name:string,file:string}[]} */
const collect = (kind) => {
  const out = [];
  for (const plugin of PLUGINS) {
    if (kind === "skills") {
      for (const name of listDirs(`plugins/${plugin}/skills`)) {
        const file = `plugins/${plugin}/skills/${name}/SKILL.md`;
        if (fs.existsSync(path.join(ROOT, file))) out.push({ plugin, name, file });
      }
    } else {
      const dir = path.join(ROOT, `plugins/${plugin}/agents`);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
        out.push({ plugin, name: f.replace(/\.md$/, ""), file: `plugins/${plugin}/agents/${f}` });
      }
    }
  }
  return out;
};

const SKILLS = collect("skills");
const AGENTS = collect("agents");

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8").replace(/\r\n/g, "\n");

/** HTML コメント（`<!-- ... -->`）を落とす。**ここが本検査の要点**（→ 冒頭の注記） */
export const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");

/** 走査対象: プラグインの本文とテンプレート層の md（定義ファイル自身は呼び出し元から除く） */
const walk = (rel, acc = []) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return acc;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(child, acc);
    else if (e.name.endsWith(".md")) acc.push(child);
  }
  return acc;
};

const CORPUS = [...walk("plugins"), ...walk("templates")];

// ---------------------------------------------------------------------------
// 1. エージェントには呼び出し導線が要る（H25）
// ---------------------------------------------------------------------------

test("配布するエージェントには、コメント外からの呼び出しがある", () => {
  const orphans = [];
  for (const a of AGENTS) {
    const callers = CORPUS.filter((f) => f !== a.file && stripComments(read(f)).includes(a.name));
    if (callers.length === 0) orphans.push(a.name);
  }
  assert.deepEqual(
    orphans,
    [],
    `呼び出し導線の無いエージェント: ${orphans.join(", ")}\n` +
      "スキルの本文かテンプレート層から呼ぶこと。**コメントブロックの中は導線と認めない**\n" +
      "（実測: coding-specialist は「作成後、このセクションは削除してよい」と書かれた\n" +
      "  コメント内の1行だけが呼び出しで、4ヶ月間0回だった）",
  );
});

// ---------------------------------------------------------------------------
// 2. スキルは利用者から見えるところに列挙されている
// ---------------------------------------------------------------------------

test("配布するスキルは CLAUDE.md（base か環境セクション）に列挙されている", () => {
  const listings = ["templates/base/CLAUDE.md", ...PLUGINS.map(() => null)]
    .filter(Boolean)
    .concat(walk("templates").filter((f) => f.endsWith("CLAUDE.section.md")));
  const text = listings.map((f) => stripComments(read(f))).join("\n");
  const missing = SKILLS.filter((s) => !text.includes(`:${s.name}`)).map((s) => `${s.plugin}:${s.name}`);
  assert.deepEqual(
    missing,
    [],
    `CLAUDE.md に列挙されていないスキル: ${missing.join(", ")}\n` +
      "列挙されていないスキルは、ユーザーにも AI にも存在が見えない",
  );
});

// ---------------------------------------------------------------------------
// 3. 散文中のスキル参照は実在する
// ---------------------------------------------------------------------------

/**
 * 記法の説明で使う占位語。**安易に増やさないこと** —
 * ここへ足すたびに検査の網が粗くなる。実在するスキル名に寄せられないか先に考える。
 */
const PLACEHOLDERS = new Set(["xxx"]);

test("散文で参照している `/<plugin>:<skill>` はすべて実在する", () => {
  const known = new Set(SKILLS.map((s) => `${s.plugin}:${s.name}`));
  const bad = [];
  for (const f of CORPUS) {
    for (const m of stripComments(read(f)).matchAll(/\/(harness-[a-z]+):([a-z][a-z0-9-]*)/g)) {
      const ref = `${m[1]}:${m[2]}`;
      if (PLACEHOLDERS.has(m[2])) continue;
      if (!known.has(ref)) bad.push(`${f} -> /${ref}`);
    }
  }
  assert.deepEqual(bad, [], `実在しないスキルを参照している:\n  ${bad.join("\n  ")}`);
});

// ---------------------------------------------------------------------------
// 4. 「自動実行される」と書いたものには、実際に呼び出しがある（H24）
// ---------------------------------------------------------------------------

test("「自動実行」と主張しているスキルには、実際の呼び出しがある", () => {
  const claims = [];
  for (const f of CORPUS) {
    for (const line of stripComments(read(f)).split("\n")) {
      if (!/自動実行|自動で(呼|実行)/.test(line)) continue;
      for (const m of line.matchAll(/\/(?:harness-[a-z]+:)?([a-z][a-z0-9-]*)/g)) {
        const name = m[1];
        if (!SKILLS.some((s) => s.name === name)) continue;
        // ⚠️ **「X が Y を自動で呼ぶ」の X（呼ぶ側）を、呼ばれる側と取り違えないこと。**
        //    格助詞「が」が続く参照は**動作主**なので除く。
        //    （この除外を入れるまで、本体で偽陽性が2件出た）
        const after = line.slice(m.index + m[0].length).replace(/^[`*\s）)]+/, "");
        if (after.startsWith("が")) continue;
        claims.push({ file: f, name, line: line.trim() });
      }
    }
  }
  const broken = [];
  for (const c of claims) {
    // 「自動実行される」は「**別のスキルが呼ぶ**」という主張なので、次の2つで絞る。
    //
    // ⚠️ ①**一覧表の「言及」を呼び出しと数えない。** `templates/*/CLAUDE.md` のスキル表には
    //    全スキルが載っているので、含めると**どんなスキルでも「呼び出しあり」になり検査が死ぬ**。
    //    → 呼び出し元は**スキルの本文だけ**にする。
    //
    // ⚠️ ②**素の名前の言及を呼び出しと数えない。** 「`update-docs` / `sync-check` で
    //    設計書をまとめて更新した後」のような**時期の説明**は呼び出しではない。
    //    → **名前空間つきの起動形式（`/harness-core:sync-check`）だけ**を呼び出しと認める。
    //
    // この2つを入れるまで、**H24 を再現した複製がこの検査を素通りした**（2回とも）。
    const def = SKILLS.find((s) => s.name === c.name);
    // 注: テンプレートリテラルに `\b` を直書きするとバックスペース文字になる。String.raw で組む
    const invocation = new RegExp(String.raw`/harness-[a-z]+:` + c.name + String.raw`\b`);
    const callers = SKILLS.map((s) => s.file)
      .filter((f) => f !== def.file && f !== c.file)
      .filter((f) => invocation.test(stripComments(read(f))));
    if (callers.length === 0) broken.push(`${c.file}: 「${c.line.slice(0, 60)}…」`);
  }
  assert.deepEqual(
    broken,
    [],
    `「自動実行される」と書いてあるが、呼び出しが見当たらない:\n  ${broken.join("\n  ")}\n` +
      "（実測: sync-check は「update-docs の完了時に自動実行」と書かれていたが実装が無く、4ヶ月0回だった）",
  );
});

// ---------------------------------------------------------------------------
// 5. エージェントのモデル指定
// ---------------------------------------------------------------------------

/**
 * 既定は `sonnet`。**例外はここに明示する**（理由つき）。
 * 増やすときは「なぜ上位モデルが要るのか」を書くこと。書けないなら既定でよい。
 */
const MODEL_EXCEPTIONS = {
  "japanese-proofreader": { model: "fable", why: "文章の自然さを判断する作業のため" },
};

test("すべてのエージェントが model を持ち、既定は sonnet（例外は明示リストのみ）", () => {
  const bad = [];
  for (const a of AGENTS) {
    const m = read(a.file).match(/^model:\s*(\S+)\s*$/m);
    if (!m) {
      bad.push(`${a.name}: model が無い（メインのモデルを継承してしまう）`);
      continue;
    }
    const expected = MODEL_EXCEPTIONS[a.name]?.model ?? "sonnet";
    if (m[1] !== expected) bad.push(`${a.name}: model=${m[1]}（期待 ${expected}）`);
  }
  assert.deepEqual(
    bad,
    [],
    `モデル指定の不一致:\n  ${bad.join("\n  ")}\n` +
      "model が無いとメインのモデルを継承し、委譲の理由の1つ（コスト）が消える",
  );
});

// ---------------------------------------------------------------------------
// 6. 検査そのものの検査（stripComments が効いているか）
// ---------------------------------------------------------------------------

test("stripComments はコメント内の呼び出しを落とす", () => {
  assert.equal(stripComments("a <!-- coding-specialist --> b").includes("coding-specialist"), false);
  assert.equal(stripComments("a\n<!--\n1. coding-specialist で実装\n-->\nb").includes("coding-specialist"), false);
  // 複数ブロック・コメント外は残す
  assert.equal(stripComments("<!--x-->keep<!--y-->").trim(), "keep");
  assert.equal(stripComments("coding-specialist へ委譲する").includes("coding-specialist"), true);
});
