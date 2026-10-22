import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins/harness-core/hooks/scripts/whole-review-nudge.js");
const require = createRequire(import.meta.url);
const nudge = require(SCRIPT);

/**
 * 全体査読の催促（0.44.0）
 *
 * **知らせるだけで止めない。自動では回さない。** だから壊れても誰も気づかない —— 機械で守る。
 *
 * 守るもの:
 *   - 閾値の判定は「以上」（5 本と決めたら 5 本目で鳴る）。キーが無ければ null、正数以外の軸は見ない
 *   - 記録が無ければ初コミットから測る（「一度も回していない」）
 *   - `--mark` は HEAD を記録し、以後その先から測る。`--snooze` は HEAD から再び溜まるまで黙る
 */

// ---------------------------------------------------------------------------
// 純関数
// ---------------------------------------------------------------------------

test("thresholdsOf: キーが無い・オブジェクトでない・正数が1つも無い → null", () => {
  assert.equal(nudge.thresholdsOf({}), null);
  assert.equal(nudge.thresholdsOf({ wholeReview: {} }), null);
  assert.equal(nudge.thresholdsOf({ wholeReview: { nudge: "5" } }), null);
  assert.equal(nudge.thresholdsOf({ wholeReview: { nudge: { completedFeatures: 0, sourceLines: -1, commits: "x" } } }), null);
});

test("thresholdsOf: 正数の軸だけ採り、それ以外は null（その軸は見ない）", () => {
  assert.deepEqual(nudge.thresholdsOf({ wholeReview: { nudge: { completedFeatures: 5 } } }), {
    completedFeatures: 5,
    sourceLines: null,
    commits: null,
  });
  assert.deepEqual(nudge.thresholdsOf({ wholeReview: { nudge: { completedFeatures: "5", sourceLines: 3000, commits: null } } }), {
    completedFeatures: 5,
    sourceLines: 3000,
    commits: null,
  });
});

test("exceededAxes: 境界は「以上」。達した軸だけ返す", () => {
  const t = { completedFeatures: 5, sourceLines: 3000, commits: 50 };
  assert.deepEqual(nudge.exceededAxes({ completedFeatures: 4, sourceLines: 2999, commits: 49 }, t), []);
  assert.deepEqual(nudge.exceededAxes({ completedFeatures: 5, sourceLines: 0, commits: 0 }, t), ["completedFeatures"]);
  assert.deepEqual(nudge.exceededAxes({ completedFeatures: 0, sourceLines: 3000, commits: 50 }, t), ["sourceLines", "commits"]);
  // null の軸は見ない
  assert.deepEqual(nudge.exceededAxes({ completedFeatures: 100, sourceLines: 100, commits: 100 }, { completedFeatures: null, sourceLines: null, commits: 50 }), ["commits"]);
  assert.deepEqual(nudge.exceededAxes({ completedFeatures: 100 }, null), []);
});

// ---------------------------------------------------------------------------
// 実リポジトリ
// ---------------------------------------------------------------------------

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-whole-review-"));
  const git = (...args) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "docs", "features", "completed"), { recursive: true });
  const commit = (files, msg) => {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
      git("add", rel);
    }
    git("commit", "-q", "-m", msg);
    return git("rev-parse", "HEAD");
  };
  const config = (nudgeCfg) =>
    fs.writeFileSync(
      path.join(dir, ".claude", "harness.config.json"),
      JSON.stringify(
        { schemaVersion: 1, environment: "nextjs", commands: {}, gates: { preCommit: [] }, paths: { source: ["src/**"] }, ...(nudgeCfg ? { wholeReview: { nudge: nudgeCfg } } : {}) },
        null,
        2,
      ),
    );
  const run = (...args) =>
    execFileSync("node", [SCRIPT, ...args], {
      cwd: dir,
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
  return { dir, git, commit, config, run };
}

test("記録が無ければ初コミットから測り、閾値に達したら「一度も回していない」と知らせる", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "a\n" }, "1");
  r.commit({ "docs/features/completed/20260101_x.md": "# x\n", "docs/features/completed/20260102_y.md": "# y\n" }, "2");
  r.config({ completedFeatures: 2 });
  const out = r.run();
  assert.match(out, /一度も回していない/);
  assert.match(out, /完了 2 本/);
  const json = JSON.parse(r.run("--json"));
  assert.equal(json.measured.base.kind, "first");
  assert.deepEqual(json.axes, ["completedFeatures"]);
});

test("閾値のキーが無ければ何も出さない（既存の適用先で鳴らない）", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "a\n" }, "1");
  r.commit({ "docs/features/completed/20260101_x.md": "# x\n" }, "2");
  r.config(null);
  assert.equal(r.run(), "");
  assert.equal(JSON.parse(r.run("--json")), null);
});

test("--mark で HEAD を記録すると、その先から測る。src の差分行は paths.source だけを数える", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "a\n" }, "1");
  r.commit({ "docs/features/completed/20260101_x.md": "# x\n" }, "2");
  r.config({ completedFeatures: 1, sourceLines: 3 });
  assert.match(r.run(), /目安に達しています/);

  r.run("--mark", "docs/reviews/x.md");
  const marker = JSON.parse(fs.readFileSync(path.join(r.dir, ".claude", "whole-review.json"), "utf-8"));
  assert.ok(!fs.existsSync(path.join(r.dir, ".claude", ".whole-review.json")), "旧ファイルには書かない");
  assert.equal(marker.lastCommit, r.git("rev-parse", "HEAD"));
  assert.equal(marker.reviewFile, "docs/reviews/x.md");
  assert.equal(r.run(), "", "記録直後は何も溜まっていないので黙る");

  // docs だけ 10 行増やしても src の軸は動かない
  r.commit({ "docs/notes.md": "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n" }, "3");
  assert.equal(r.run(), "");
  // src を 3 行変えると達する
  r.commit({ "src/a.ts": "a\nb\nc\nd\n" }, "4");
  const json = JSON.parse(r.run("--json"));
  assert.equal(json.measured.base.kind, "last");
  assert.equal(json.measured.sourceLines, 3);
  assert.deepEqual(json.axes, ["sourceLines"]);
});

test("--snooze は HEAD から再び溜まるまで黙る。記録のコミットが実在しなければ初コミットから", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "a\n" }, "1");
  r.commit({ "docs/features/completed/20260101_x.md": "# x\n" }, "2");
  r.config({ completedFeatures: 1 });
  assert.match(r.run(), /目安に達しています/);
  r.run("--snooze");
  assert.equal(r.run(), "", "見送り直後は黙る");
  r.commit({ "docs/features/completed/20260103_z.md": "# z\n" }, "3");
  const json = JSON.parse(r.run("--json"));
  assert.equal(json.measured.base.kind, "snoozed");
  assert.match(json.line, /見送った [0-9a-f]{7} から/);

  // 実在しないコミットを記録に書く → 初コミットから
  fs.writeFileSync(path.join(r.dir, ".claude", "whole-review.json"), JSON.stringify({ lastCommit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }));
  fs.rmSync(path.join(r.dir, ".claude", ".whole-review.local.json"), { force: true });
  assert.equal(JSON.parse(r.run("--json")).measured.base.kind, "first");
});

test("snoozedAt だけが実在しないとき、lastCommit を飛ばして初コミットへ落ちない（査読 #6）", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "a\n" }, "1");
  r.commit({ "docs/features/completed/20260101_x.md": "# x\n" }, "2");
  r.config({ completedFeatures: 1 });
  r.run("--mark");
  const last = r.git("rev-parse", "HEAD");
  r.commit({ "docs/features/completed/20260102_y.md": "# y\n" }, "3");
  fs.writeFileSync(path.join(r.dir, ".claude", "whole-review.json"), JSON.stringify({ lastCommit: last }));
  fs.writeFileSync(path.join(r.dir, ".claude", ".whole-review.local.json"), JSON.stringify({ snoozedAt: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }));
  const json = JSON.parse(r.run("--json"));
  assert.equal(json.measured.base.kind, "last");
  assert.equal(json.measured.completedFeatures, 1, "lastCommit 以後の 1 本だけ（初コミットからの 2 本ではない）");
  assert.doesNotMatch(json.line, /一度も回していない/);
});

test("初コミットだけのリポジトリでも、その中身を数えて鳴る（査読 #7）", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "1\n2\n3\n4\n5\n", "docs/features/completed/20260101_x.md": "# x\n" }, "only");
  r.config({ completedFeatures: 1, sourceLines: 5, commits: 1 });
  const json = JSON.parse(r.run("--json"));
  assert.ok(json, "初コミットしか無いと黙っていた（root..HEAD が空になる）");
  assert.equal(json.measured.base.kind, "first");
  assert.deepEqual(
    { c: json.measured.completedFeatures, s: json.measured.sourceLines, n: json.measured.commits },
    { c: 1, s: 5, n: 1 },
  );
});

test("planned/ から completed/ への git mv（rename）も「完了した設計書」に数える。completed 内の改名は数えない", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "a\n" }, "1");
  r.config({ completedFeatures: 1 });
  r.run("--mark");
  r.commit({ "docs/features/planned/20260101_p.md": "# p\n" }, "planned");
  assert.equal(r.run(), "", "planned/ に増えただけでは数えない");
  fs.mkdirSync(path.join(r.dir, "docs", "features", "completed"), { recursive: true });
  r.git("mv", "docs/features/planned/20260101_p.md", "docs/features/completed/20260101_p.md");
  r.git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "mv", "--", "docs/features/planned/20260101_p.md", "docs/features/completed/20260101_p.md");
  assert.equal(JSON.parse(r.run("--json")).measured.completedFeatures, 1, "rename が A として数わる");
  r.run("--mark");
  r.git("mv", "docs/features/completed/20260101_p.md", "docs/features/completed/20260101_q.md");
  r.git("-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "rename", "--", "docs/features/completed/20260101_p.md", "docs/features/completed/20260101_q.md");
  assert.equal(r.run(), "", "completed 内の改名は二重に数えない");
});

test("paths.source が無い・ブレースを含むときは差分全体を採り、文に「paths.source 未使用」と出る（査読 #8）", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "a\n" }, "1");
  r.config({ sourceLines: 3 });
  r.run("--mark");
  r.commit({ "docs/notes.md": "1\n2\n3\n" }, "docs");
  // paths.source を外す
  const cfgPath = path.join(r.dir, ".claude", "harness.config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
  delete cfg.paths;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const json = JSON.parse(r.run("--json"));
  assert.equal(json.measured.sourceScoped, false);
  assert.match(json.line, /paths\.source 未使用/);
  // ブレース
  cfg.paths = { source: ["src/**/*.{ts,tsx}"] };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  assert.equal(JSON.parse(r.run("--json")).measured.sourceScoped, false);
});

test("日本語のファイル名でも完了した設計書を数える（core.quotepath の引用符つき八進数で落とさない）", () => {
  // 実プロジェクト（Windows・既定の core.quotepath=true）で、完了 13 本を 0 本と数えていた（0.44.1）。
  // 設計書の名前は日本語が標準なので、ここが落ちると催促が一度も鳴らない
  const r = makeRepo();
  r.git("config", "core.quotepath", "true");
  r.commit({ "src/a.ts": "a\n" }, "1");
  r.config({ completedFeatures: 2 });
  r.run("--mark");
  r.commit({ "docs/features/completed/20260101_日本語の設計書.md": "# x\n" }, "2");
  r.commit({ "docs/features/completed/20260102_もう1本.md": "# y\n" }, "3");
  const json = JSON.parse(r.run("--json"));
  assert.ok(json, "日本語名の完了を数えていない");
  assert.equal(json.measured.completedFeatures, 2);
});

test("閾値は「以上」で鳴る（5 本と決めたら 5 本目）", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "a\n" }, "1");
  r.config({ completedFeatures: 2 });
  r.commit({ "docs/features/completed/20260101_x.md": "# x\n" }, "2");
  assert.equal(r.run(), "", "1 本では鳴らない");
  r.commit({ "docs/features/completed/20260102_y.md": "# y\n" }, "3");
  assert.match(r.run(), /完了 2 本/);
});

test("SessionStart で案内したあとは短縮形（同じ日の pre-push-check / complete-feature で長文を繰り返さない）", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "a\n" }, "1");
  r.commit({ "docs/features/completed/20260101_x.md": "# x\n" }, "2");
  r.config({ completedFeatures: 1 });
  fs.writeFileSync(path.join(r.dir, ".claude", ".whole-review.local.json"), JSON.stringify({ notifiedAt: new Date().toISOString() }));
  assert.match(r.run(), /セッション開始時に案内済み/);
  assert.doesNotMatch(r.run("--full"), /案内済み/);
});

// ---------------------------------------------------------------------------
// 0.46.0（H103）: 記録を「プロジェクトの事実」と「マシンローカル」に分ける
// ---------------------------------------------------------------------------

test("旧ファイル（.claude/.whole-review.json）しか無ければ、そこから lastCommit と snoozedAt を引き継ぐ（消さない）", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "a\n" }, "1");
  const last = r.git("rev-parse", "HEAD");
  r.commit({ "docs/features/completed/20260101_x.md": "# x\n" }, "2");
  r.config({ completedFeatures: 1 });
  const legacy = path.join(r.dir, ".claude", ".whole-review.json");
  fs.writeFileSync(legacy, JSON.stringify({ lastCommit: last, date: "2026-10-14", reviewFile: "docs/reviews/old.md", notifiedAt: new Date().toISOString() }));
  const json = JSON.parse(r.run("--json"));
  assert.equal(json.measured.base.kind, "last", "旧ファイルの lastCommit を起点にする");
  assert.match(json.line, /案内済み/, "旧ファイルの notifiedAt も引き継ぐ");
  assert.ok(fs.existsSync(legacy), "旧ファイルは消さない");
  // --mark すると新しい方が正になり、旧ファイルは触らない
  r.run("--mark");
  assert.ok(fs.existsSync(path.join(r.dir, ".claude", "whole-review.json")));
  assert.equal(JSON.parse(fs.readFileSync(legacy, "utf-8")).lastCommit, last, "旧ファイルは書き換えない");
});

test("--mark は共有側だけを書き、--snooze はローカル側だけを書く。--mark は見送りを消す", () => {
  const r = makeRepo();
  r.commit({ "src/a.ts": "a\n" }, "1");
  r.config({ completedFeatures: 1 });
  r.run("--snooze");
  const shared = path.join(r.dir, ".claude", "whole-review.json");
  const local = path.join(r.dir, ".claude", ".whole-review.local.json");
  assert.ok(!fs.existsSync(shared), "--snooze は共有側を作らない");
  assert.equal(JSON.parse(fs.readFileSync(local, "utf-8")).snoozedAt, r.git("rev-parse", "HEAD"));
  r.run("--mark", "docs/reviews/x.md");
  const s = JSON.parse(fs.readFileSync(shared, "utf-8"));
  assert.deepEqual(Object.keys(s).sort(), ["date", "lastCommit", "reviewFile"], "共有側には事実の 3 つだけ");
  assert.equal(JSON.parse(fs.readFileSync(local, "utf-8")).snoozedAt, undefined, "回した以上、見送りの起点は消す");
});

test("共有側のファイルを別クローンへ写すと、そちらも同じ起点から測る（2 台で「初回」にならない）", () => {
  const a = makeRepo();
  a.commit({ "src/a.ts": "a\n" }, "1");
  a.commit({ "docs/features/completed/20260101_x.md": "# x\n" }, "2");
  a.config({ completedFeatures: 1 });
  a.run("--mark", "docs/reviews/x.md");
  const sharedBody = fs.readFileSync(path.join(a.dir, ".claude", "whole-review.json"), "utf-8");
  // 別クローン（同じ履歴）に共有側だけを置く
  const b = makeRepo();
  fs.rmSync(b.dir, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", a.dir, b.dir]);
  fs.mkdirSync(path.join(b.dir, ".claude"), { recursive: true });
  b.config({ completedFeatures: 1 });
  fs.writeFileSync(path.join(b.dir, ".claude", "whole-review.json"), sharedBody);
  assert.equal(b.run(), "", "写した起点から測るので、何も溜まっていないと黙る");
  const json = JSON.parse(b.run("--json"));
  assert.equal(json, null);
});
