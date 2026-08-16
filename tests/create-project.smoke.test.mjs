import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "tools", "create-project.mjs");

// 3環境とも生成が通り、**生成物に未置換のプレースホルダが 0 件**であることを見る。
// 生成物の中身までは検査しない（それは harness-update の3点比較の仕事）。
//
// ⚠️ `--dry-run` の出力には「置換内容」の表があり `{{NAME}} -> 値` が並ぶ。
//    そこを grep しても未置換の検出にはならない。**実際に生成して中身を見る。**

const ENVS = [
  { env: "nextjs", set: { PROJECT_NAME: "SmokeApp", PROJECT_DESCRIPTION: "スモークテスト用" } },
  { env: "unity", set: { PROJECT_NAME: "SmokeApp", PROJECT_DESCRIPTION: "スモークテスト用" } },
  {
    env: "wpf",
    set: {
      PROJECT_NAME: "SmokeApp",
      PROJECT_DESCRIPTION: "スモークテスト用",
      CORE_PROJECT: "SmokeApp.Core",
      UI_PROJECT: "SmokeApp.UI",
    },
  },
];

const argsFor = (env, set, dest, extra = []) => {
  const a = [SCRIPT, "--env", env, "--dest", dest, "--yes", ...extra];
  for (const [k, v] of Object.entries(set)) a.push("--set", `${k}=${v}`);
  return a;
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

for (const { env, set } of ENVS) {
  test(`生成物に未置換のプレースホルダが無い（${env}）`, () => {
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), `harness-smoke-${env}-`));
    try {
      execFileSync(process.execPath, argsFor(env, set, dest), {
        encoding: "utf-8",
        stdio: "pipe",
        timeout: 60000,
      });

      const files = walk(dest);
      assert.ok(files.length > 0, "1件も生成されていない");

      const left = [];
      for (const f of files) {
        let text;
        try {
          text = fs.readFileSync(f, "utf-8");
        } catch {
          continue; // 読めないもの（バイナリ等）は対象外
        }
        for (const m of text.matchAll(/\{\{[A-Z_]+\}\}/g)) {
          left.push(`${path.relative(dest, f)}: ${m[0]}`);
        }
      }
      assert.deepEqual(left, [], `未置換のプレースホルダが残っている:\n${left.join("\n")}`);
    } finally {
      fs.rmSync(dest, { recursive: true, force: true });
    }
  });
}

test("--dry-run は何も書き込まない", () => {
  const { env, set } = ENVS[0];
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "harness-smoke-dry-"));
  try {
    execFileSync(process.execPath, argsFor(env, set, dest, ["--dry-run"]), {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 60000,
    });
    assert.deepEqual(fs.readdirSync(dest), []);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("未知の環境はエラーになる", () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "harness-smoke-bad-"));
  try {
    assert.throws(() =>
      execFileSync(
        process.execPath,
        [SCRIPT, "--env", "nosuchenv", "--dest", dest, "--dry-run", "--yes"],
        { encoding: "utf-8", stdio: "pipe", timeout: 60000 }
      )
    );
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});
