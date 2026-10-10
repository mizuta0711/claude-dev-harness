import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { isNeverTouch, isSeedOnce, seedOnceVerdict, classify } = await import(
  pathToFileURL(
    path.join(ROOT, "plugins", "harness-core", "skills", "harness-update", "scripts", "harness-diff.mjs")
  ).href
);

// 追従の対象から外す仕掛けは2つあり、**意味が違う**。
//   NEVER_TOUCH … 比較にも apply にも出さない（初回も配らない）
//   SEED_ONCE   … 現物が無ければ配り、**あれば以後触らない**
// 取り違えると、①プロジェクトが育てたファイルを雛形で無断上書きする
// ②まだ持っていないプロジェクトへ初回を配る経路が消える、のどちらかになる。

test("environment.md は配り切り（NEVER_TOUCH ではない）", () => {
  // 0.25.0 で追従対象と宣言し、Next.js 15.3 のプロジェクトへ「Next.js 16」と
  // 書いた雛形を自動適用した。0.28.0 でいったん NEVER_TOUCH に入れたが、
  // それだと **0.25.0 未満のプロジェクトへ初回を配れない**（`CLAUDE.md` が
  // `@` で読み込むので、無いと環境節が無言で消える）。配り切りが正しい。
  assert.ok(isSeedOnce(".claude/harness/environment.md"));
  assert.ok(!isNeverTouch(".claude/harness/environment.md"));
});

test("core.md は追従する（ハーネスが持つ規律そのもの）", () => {
  assert.ok(!isNeverTouch(".claude/harness/core.md"));
  assert.ok(!isSeedOnce(".claude/harness/core.md"));
});

test("CLAUDE.md はどちらの仕掛けにも載せない（分類で守る）", () => {
  // 除外や配り切りにすると、骨組みの改善をプロジェクトへ運べなくなる。
  // 0.25.0 以降は `project-local` として保持されるので、分類だけで足りる。
  assert.ok(!isNeverTouch("CLAUDE.md"));
  assert.ok(!isSeedOnce("CLAUDE.md"));
});

test("設計方針層の中身は追従しないが README は追従する", () => {
  assert.ok(isNeverTouch(".claude/01_development_docs/01_architecture.md"));
  assert.ok(!isNeverTouch(".claude/01_development_docs/README.md"));
});

test("設計書は台帳だけ追従する", () => {
  assert.ok(isNeverTouch("docs/設計書/API一覧.md"));
  assert.ok(!isNeverTouch("docs/設計書/.doc-sync.md"));
});

test("docs の置き場（.gitkeep）は配り切りで、中身は触らない", () => {
  // 0.27.0 で `docs/features/planned/` を足したが、`NEVER_TOUCH` が
  // `docs/features/` を丸ごと除外していたため、**既存7プロジェクトの 0/7 に届かなかった**。
  // `plan-milestones` / `new-feature` / `design-review` の3スキルが
  // 指示する置き場が無い状態で、`plan-milestones` は実際に空振りする。
  // 骨格（置き場）は配り、中身（設計書・レビュー記録）は触らない。
  for (const rel of [
    "docs/features/planned/.gitkeep",
    "docs/features/pending/.gitkeep",
    "docs/features/completed/.gitkeep",
    "docs/reviews/.gitkeep",
  ]) {
    assert.ok(isSeedOnce(rel), `${rel} は配り切りであるべき`);
    assert.ok(!isNeverTouch(rel), `${rel} は除外してはいけない（初回が配られない）`);
  }
  // 中身は従来どおり触らない
  assert.ok(isNeverTouch("docs/features/planned/20261010_x.md"));
  assert.ok(isNeverTouch("docs/features/20261010_x.md"));
  assert.ok(isNeverTouch("docs/reviews/20261010_x.md"));
});

// ---- 配り切りが「本当に配られるか」を classify ごしに押さえる ----
// **述語（isSeedOnce）が真でも、配られるとは限らない。**
// 0.31.1 の初版は述語だけをテストしており、`classify` が
// `project-local`（＝プロジェクトが消した・保持）を返すことを見逃した。
// その結果 baseline が 0.27.0 以降の**5プロジェクトで1つも配られなかった**。

test("baseline に入っている配り切りは、現物が無ければ配られる（project-local にしない）", () => {
  // A（baseline）に有り・B（最新）に有り・C（現物）に無し。
  // classify はこれを「プロジェクト側で削除された」と読むので、通してはいけない。
  assert.equal(classify("", "", null).kind, "project-local");

  // 置き場そのものが無ければ配る
  const v = seedOnceVerdict("docs/features/planned/.gitkeep", path.join(ROOT, "tests", "__no_such_project__"));
  assert.equal(v.kind, "template-improvement");
});

test("置き場が実在するなら .gitkeep は配らない（消したものを再提案しない）", () => {
  // `.gitkeep` は「空ディレクトリを git に載せる」ためのもの。
  // 中身があって消したプロジェクト（実測: 実プロジェクト2件）へ出し続けない。
  // ROOT/tests は実在するディレクトリなので、その .gitkeep は不要と判定されるべき。
  assert.equal(seedOnceVerdict("tests/.gitkeep", ROOT), null);
});

test("配り切りで .gitkeep 以外は、置き場の有無を見ずに配る", () => {
  // environment.md はファイルそのものが要る（CLAUDE.md が @ で読み込む）。
  // 「ディレクトリがあるから不要」にはならない。
  const v = seedOnceVerdict(".claude/harness/environment.md", ROOT);
  assert.equal(v.kind, "template-improvement");
});

test("配り切りの .gitkeep は docs 配下だけ", () => {
  // `.gitkeep` ならどこでも配る、にはしない（他の層の所有境界を崩す）。
  assert.ok(!isSeedOnce(".claude/01_development_docs/.gitkeep"));
  assert.ok(!isSeedOnce(".gitkeep"));
  // 似た名前へ広がらない
  assert.ok(!isSeedOnce("docs/features/planned/.gitkeep.bak"));
  // **`.gitkeep` はファイル名の全体でなければならない。**
  // 初版は `/^docs\/.*\.gitkeep$/` で、`foo.gitkeep` 型にも当たっていた。
  for (const rel of [
    "docs/features/foo.gitkeep",
    "docs/reviews/sub/not.gitkeep",
    "docs/features/pending/x_.gitkeep",
  ]) {
    assert.ok(!isSeedOnce(rel), `${rel} は配り切りではない`);
  }
  // 逆に、除外からも漏れていてはいけない
  assert.ok(isNeverTouch("docs/features/foo.gitkeep"));
  assert.ok(isNeverTouch("docs/reviews/sub/not.gitkeep"));
});

test("除外と配り切りの両方に当たるときは、除外が勝つ", () => {
  // `docs/設計書/.gitkeep` は NEVER_TOUCH（台帳以外の設計書）と SEED_ONCE の両方に当たる。
  // analyze も apply も `isNeverTouch` を先に見るので除外が勝つ。
  // **テンプレートには存在しないので実害は無いが、取り決めが無いと次に触る人が迷う。**
  assert.ok(isNeverTouch("docs/設計書/.gitkeep"));
  assert.ok(isSeedOnce("docs/設計書/.gitkeep"));
});

test("配り切りは完全一致で、似た名前に広がらない", () => {
  assert.ok(!isSeedOnce(".claude/harness/environment.md.bak"));
  assert.ok(!isSeedOnce("docs/.claude/harness/environment.md"));
  assert.ok(!isSeedOnce(".claude/harness/environment.local.md"));
});

// ---- apply の経路を実際に通す（単体テストでは担保できない） ----
// `isSeedOnce` が真でも、**apply が止めなければ上書きは起きる**。
// 0.28.0 の初版は「NEVER_TOUCH に入れる」で、apply は止まるが
// **初回を配る経路も消えていた**。両方を1本で押さえる。

import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";

const SCRIPT = path.join(
  ROOT, "plugins", "harness-core", "skills", "harness-update", "scripts", "harness-diff.mjs"
);

const runApply = (project, rel) =>
  spawnSync(process.execPath, [SCRIPT, "apply", "--project", project, rel], { encoding: "utf-8" });

test("apply は、現物がある配り切りファイルを上書きしない", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seed-once-"));
  try {
    const rel = ".claude/harness/environment.md";
    fs.mkdirSync(path.join(dir, ".claude/harness"), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "# このプロジェクトが記入した実態\n");
    // report.json はあえて「適用してよい」と言っている状態にする。
    // ガードが report より先に効くことを見るため。
    fs.mkdirSync(path.join(dir, ".claude/.harness-update"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude/.harness-update/report.json"),
      JSON.stringify({ idealDir: ".claude/.harness-update/latest", files: [{ file: rel, kind: "template-improvement" }] })
    );

    const r = runApply(dir, rel);
    assert.notEqual(r.status, 0, "現物があるのに apply が通ってしまった");
    assert.match(r.stderr + r.stdout, /配り切り/);
    assert.equal(
      fs.readFileSync(path.join(dir, rel), "utf-8"),
      "# このプロジェクトが記入した実態\n",
      "現物が書き換わっている"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("NEVER_TOUCH のファイルは apply が拒否する", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "never-touch-"));
  try {
    // report.json は apply の入口で必須。ガードはその後に効く。
    fs.mkdirSync(path.join(dir, ".claude/.harness-update"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, ".claude/.harness-update/report.json"),
      JSON.stringify({ idealDir: ".claude/.harness-update/latest", files: [] })
    );
    const r = runApply(dir, ".claude/01_development_docs/01_architecture.md");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /追従対象外/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
