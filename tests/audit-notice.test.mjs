import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins/harness-core/hooks/scripts/session-start-context.js");

/**
 * SessionStart の「利用実績の監査から N 日」通知
 *
 * **知らせるだけで止めない**ので、壊れても誰も気づかない。だから機械で守る。
 *
 * ## ⚠️ 実際に踏んだ取りこぼし
 *
 * `Number(x) || 既定` と書いたため、**`intervalDays: 0`（通知しない）が既定の 30 に化けて
 * 無効化できなかった**。手で5ケース試して初めて分かった。
 * **失敗したケースは消さず、期待値として残す**（回帰の記録）。
 */

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/** 使い捨てプロジェクトを作ってフックを1回走らせ、画面へ出る1行を返す */
function runHook({ appliedAt, lastRunAt, intervalDays } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-audit-"));
  try {
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    const config = { schemaVersion: 1, environment: "wpf", commands: {}, gates: { preCommit: [] } };
    if (intervalDays !== undefined) config.audit = { intervalDays };
    fs.writeFileSync(path.join(dir, ".claude", "harness.config.json"), JSON.stringify(config, null, 2));
    if (appliedAt) {
      fs.writeFileSync(
        path.join(dir, ".claude", "harness-baseline.json"),
        JSON.stringify({ templatesCommit: "0".repeat(40), environment: "wpf", appliedAt }, null, 2),
      );
    }
    if (lastRunAt) {
      fs.writeFileSync(path.join(dir, ".claude", ".harness-audit.json"), JSON.stringify({ lastRunAt }, null, 2));
    }
    const payload = JSON.stringify({ cwd: dir, hook_event_name: "SessionStart", source: "startup" });
    const out = execFileSync(process.execPath, [HOOK], { input: payload, encoding: "utf-8", cwd: dir });
    return JSON.parse(out).systemMessage || "";
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const notified = (msg) => msg.includes("利用実績の監査");

test("判定材料が無ければ何も言わない（導入直後に催促しない）", () => {
  assert.equal(notified(runHook()), false);
});

test("baseline が古く、まだ一度も監査していなければ知らせる", () => {
  const msg = runHook({ appliedAt: daysAgo(40) });
  assert.equal(notified(msg), true, msg);
});

test("baseline が新しければ黙る", () => {
  assert.equal(notified(runHook({ appliedAt: daysAgo(5) })), false);
});

test("直近に監査していれば黙る", () => {
  assert.equal(notified(runHook({ appliedAt: daysAgo(200), lastRunAt: daysAgo(5) })), false);
});

test("監査から間隔を過ぎたら知らせる", () => {
  const msg = runHook({ appliedAt: daysAgo(200), lastRunAt: daysAgo(45) });
  assert.equal(notified(msg), true, msg);
});

test("intervalDays: 0 は通知を止める（`Number(x) || 既定` だと 0 が化ける）", () => {
  const msg = runHook({ appliedAt: daysAgo(200), lastRunAt: daysAgo(45), intervalDays: 0 });
  assert.equal(notified(msg), false, `0 を指定したのに通知された: ${msg}`);
});

test("intervalDays を短くすると早く鳴る", () => {
  const msg = runHook({ appliedAt: daysAgo(200), lastRunAt: daysAgo(10), intervalDays: 7 });
  assert.equal(notified(msg), true, msg);
});

test("不正な intervalDays は既定（30 日）として扱う — 通知が黙って死なない", () => {
  const msg = runHook({ appliedAt: daysAgo(200), lastRunAt: daysAgo(45), intervalDays: "とても" });
  assert.equal(notified(msg), true, msg);
});
