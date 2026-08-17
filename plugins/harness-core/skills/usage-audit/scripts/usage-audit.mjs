#!/usr/bin/env node
/**
 * 利用実績の集計（transcript → 発火回数・規律の遵守）
 *
 * ## 何をするか
 *
 * Claude Code の transcript（`<projects-dir>/<project>/*.jsonl`）を読み、
 * **スキル・エージェントが実際に何回起動したか**と、
 * **規約どおりの操作が行われたか**を数える。
 *
 * ## 何をしないか
 *
 * - **要否の判断をしない。** 「0回だから要らない」は導けない
 *   （原因が「不要」なのか「未配線」なのかは、このスクリプトには分からない）
 * - **transcript の場所を推測しない。** 引数で渡されたディレクトリだけを見る。
 *   **`~/.claude` は環境ごとに別々に存在する**（Windows / WSL / devcontainer）ため、
 *   全部見つけるのは呼び出し側（SKILL.md の手順）の責任
 *
 * ## 使い方
 *
 *   node usage-audit.mjs <projects-dir> [<projects-dir> ...] [--json]
 *
 * `<projects-dir>` は `~/.claude/projects` を指す。複数渡してよい。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// **判定は自作しない。** フックが使っているのと同じ実装を読む
// （素の正規表現でコマンド名を探すと、**引用符の中やコメントの中で誤爆する** — R3）。
const require_ = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const gitScope = require_(path.resolve(HERE, "../../../hooks/scripts/git-scope.js"));

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const knownArg = args.find((a) => a.startsWith("--known="));
/** 配布物のスキル名。渡すと**それ以外を「不明」へ隔離する**（引用テキストの混入を防ぐ） */
const KNOWN = knownArg ? new Set(knownArg.slice("--known=".length).split(",").map((s) => s.trim()).filter(Boolean)) : null;
const dirs = args.filter((a) => !a.startsWith("--"));

if (dirs.length === 0) {
  console.error("使い方: node usage-audit.mjs <projects-dir> [...] [--known=a,b,c] [--json]");
  console.error("  <projects-dir> は ~/.claude/projects。**環境ごとに別々にあるので全部渡すこと**");
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 収集
// ---------------------------------------------------------------------------

/** @returns {{dir:string,project:string,file:string,mtime:Date,size:number}[]} */
const transcripts = [];
for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    console.error(`★ 見つからない: ${dir}`);
    continue;
  }
  for (const project of fs.readdirSync(dir)) {
    const pdir = path.join(dir, project);
    let st;
    try {
      st = fs.statSync(pdir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    for (const f of fs.readdirSync(pdir).filter((f) => f.endsWith(".jsonl"))) {
      const file = path.join(pdir, f);
      const s = fs.statSync(file);
      transcripts.push({ dir, project, file, mtime: s.mtime, size: s.size });
    }
  }
}

// ---------------------------------------------------------------------------
// 集計
// ---------------------------------------------------------------------------

const inc = (map, key, project) => {
  if (!map.has(key)) map.set(key, { count: 0, projects: new Set(), last: null });
  const e = map.get(key);
  e.count += 1;
  e.projects.add(project);
  return e;
};

const skills = new Map();
const unknownSkills = new Map();
const agents = new Map();
/** 規律の遵守。`hits` は違反または該当の実測 */
const discipline = {
  gitAddAll: { label: "範囲まるごとの git 操作（add -A / commit -a / stash / 範囲指定なしの破棄）", hits: [], want: "0件" },
  agentWithoutModel: { label: "model を指定しないサブエージェント起動", hits: [], want: "0件" },
  pushWithoutCheck: { label: "直前に pre-push-check の無い git push（**目安**）", hits: [], want: "0件" },
};

const SKILL_RE = /"name":"Skill","input":\{[^}]*"skill":"([^"]+)"/g;
const CMD_RE = /<command-name>\/([^<]+)<\/command-name>/g;
const AGENT_RE = /"subagent_type":"([^"]+)"/g;
const BASH_RE = /"name":"(?:Bash|PowerShell)","input":\{"command":"((?:[^"\\]|\\.)*)"/g;

/** 名前空間を落として素の名前にする（`harness-core:code-review` → `code-review`） */
const bare = (n) => n.replace(/^[a-z-]+:/, "");

for (const t of transcripts) {
  let text;
  try {
    text = fs.readFileSync(t.file, "utf-8");
  } catch (e) {
    console.error(`★ 読めない: ${t.file}（${e.message}）`);
    continue;
  }

  const record = (name) => {
    const n = bare(name);
    if (!n) return;
    // --known を渡された場合、配布物に無い名前は**隔離する**。
    // transcript には**過去のやり取りの引用**が混ざるため、素朴に数えると嘘になる
    // （実測: この監査自身の会話に出てくる `xxx` が「2回起動」として数えられた）
    const map = KNOWN && !KNOWN.has(n) ? unknownSkills : skills;
    inc(map, n, t.project).last = t.mtime;
  };
  for (const m of text.matchAll(SKILL_RE)) record(m[1]);
  for (const m of text.matchAll(CMD_RE)) record(m[1].trim().split(/\s/)[0]);
  for (const m of text.matchAll(AGENT_RE)) inc(agents, bare(m[1]), t.project).last = t.mtime;

  // --- 規律 ---
  // JSON 文字列としてエスケープされているので戻す（戻さないと判定がコマンドを読めない）
  const bashCmds = [...text.matchAll(BASH_RE)].map((m) =>
    m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
  );
  for (const c of bashCmds) {
    // **判定は自作しない。** フックと同じ `git-scope.js` を使う。
    //
    // ⚠️ 素の正規表現で `git add -A` を探すと、**引用符の中の文字列でも発火する**。
    //    実測: この検査を作ったときの初版が、`grep "git add -A"` のような
    //    **自分の調査コマンド**まで数えて **113件**という嘘の数字を出した（実際は下記のとおり）。
    if (
      gitScope.isBlockedAdd(c) ||
      gitScope.isBlockedCommitAll(c) ||
      gitScope.isBlockedStash(c) ||
      gitScope.isBlockedDiscard(c)
    ) {
      discipline.gitAddAll.hits.push({ project: t.project, cmd: c.slice(0, 80) });
    }
  }
  // push の直前に pre-push-check があるか（同一 transcript 内の出現位置で見る）
  const pushIdx = [...text.matchAll(/git\s+push/g)].map((m) => m.index);
  const checkIdx = [...text.matchAll(/pre-push-check/g)].map((m) => m.index);
  for (const p of pushIdx) {
    if (!checkIdx.some((c) => c < p)) {
      discipline.pushWithoutCheck.hits.push({ project: t.project });
      break; // 1 transcript につき1件だけ数える
    }
  }
  // Agent 起動に model があるか
  for (const m of text.matchAll(/"name":"(?:Agent|Task)","input":\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
    if (!/"model"\s*:/.test(m[1])) discipline.agentWithoutModel.hits.push({ project: t.project });
  }
}

// ---------------------------------------------------------------------------
// 出力
// ---------------------------------------------------------------------------

const dates = transcripts.map((t) => t.mtime).sort((a, b) => a - b);
const fmt = (d) => (d ? d.toISOString().slice(0, 10) : "—");
const totalMB = (transcripts.reduce((a, t) => a + t.size, 0) / 1024 / 1024).toFixed(1);

const scope = {
  projectsDirs: dirs,
  transcripts: transcripts.length,
  projects: new Set(transcripts.map((t) => t.project)).size,
  totalMB: Number(totalMB),
  from: fmt(dates[0]),
  to: fmt(dates[dates.length - 1]),
};

const toRows = (map) =>
  [...map.entries()]
    .map(([name, e]) => ({ name, count: e.count, projects: e.projects.size, last: fmt(e.last) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

const result = {
  scope,
  skills: toRows(skills),
  unknownSkills: toRows(unknownSkills),
  agents: toRows(agents),
  discipline: Object.fromEntries(
    Object.entries(discipline).map(([k, v]) => [k, { label: v.label, want: v.want, count: v.hits.length }]),
  ),
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("## 計測範囲\n");
  console.log(`| 項目 | 値 |`);
  console.log(`|------|----|`);
  console.log(`| 見たディレクトリ | ${dirs.length}件 |`);
  for (const d of dirs) console.log(`| — | \`${d}\` |`);
  console.log(`| transcript | ${scope.transcripts}件 / ${scope.projects}プロジェクト / 約${scope.totalMB}MB |`);
  console.log(`| 期間 | ${scope.from} 〜 ${scope.to} |`);
  console.log("\n> ⚠️ **`~/.claude` は環境ごとに別々にある**（Windows / WSL / devcontainer）。");
  console.log("> 上の一覧に漏れがあれば、この集計はその分だけ嘘になる。\n");

  const table = (title, rows) => {
    console.log(`\n## ${title}\n`);
    if (rows.length === 0) return console.log("（起動なし）");
    console.log(`| 名前 | 起動 | プロジェクト数 | 最終 |`);
    console.log(`|------|-----:|-------------:|------|`);
    for (const r of rows) console.log(`| \`${r.name}\` | ${r.count} | ${r.projects} | ${r.last} |`);
  };
  table("スキルの起動", result.skills);
  table("サブエージェントの起動", result.agents);
  if (KNOWN && result.unknownSkills.length) {
    table("配布物に無い名前（プロジェクト固有スキル、または引用テキストの混入。数に入れない）", result.unknownSkills);
  }

  console.log("\n## 規律の遵守\n");
  console.log(`| 項目 | 期待 | 実測 |`);
  console.log(`|------|------|-----:|`);
  for (const v of Object.values(result.discipline)) console.log(`| ${v.label} | ${v.want} | ${v.count} |`);

  console.log("\n> **ここに出ていないものは「0回」ではなく「このスクリプトが数えていない」。**");
  console.log("> 配布物との突き合わせ（何が0回か）と、0回の**原因**（未配線か／呼ばれていないか）は");
  console.log("> スキル側の手順で行う。**このスクリプトは要否を判断しない。**");
}
