/**
 * statusLine スクリプト
 *
 * Claude Code から stdin に JSON が渡される。1行を stdout に出すとステータス行に表示される。
 * jq に依存すると Windows で動かないことがあるため Node で実装している
 * （harness-core の hooks が Node を要求するため、本ハーネスを使う環境には必ず Node がある）。
 *
 * 表示内容: モデル名 / ブランチ / コンテキスト使用率 / 未コミット数 / 未プッシュ数
 * すべての取得は失敗しても落とさない（ステータス行が出ないだけで作業は止めない）。
 */
const { execSync } = require("child_process");

function read() {
  try {
    return JSON.parse(require("fs").readFileSync(0, "utf-8") || "{}");
  } catch {
    return {};
  }
}

function git(args) {
  try {
    return execSync(`git ${args}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
    }).trim();
  } catch {
    return "";
  }
}

const data = read();
const parts = [];

const model = data?.model?.display_name;
if (model) parts.push(`[${model}]`);

const branch = git("branch --show-current");
if (branch) parts.push(`🌿 ${branch}`);

// used_percentage はセッション初期や /compact 直後は null になりうる
const pct = data?.context_window?.used_percentage;
if (typeof pct === "number") parts.push(`${Math.round(pct)}% context`);

const status = git("status --porcelain");
if (status) parts.push(`✎ ${status.split("\n").length} uncommitted`);

// 未プッシュコミット数（upstream 未設定なら表示しない）
const ahead = git("rev-list --count @{upstream}..HEAD");
if (ahead && ahead !== "0") parts.push(`↑ ${ahead}`);

console.log(parts.join(" | "));
