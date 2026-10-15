/**
 * 全体査読（`/harness-core:whole-review`）の催促
 *
 * **知らせるだけ。止めない。自動では回さない。**
 *
 * 変更単位のレビュー（design-review / code-review）は、変更と変更の間に生まれる非対称を
 * 原理的に拾えない。だから全ソースを見る査読の入口（`whole-review`）があるが、
 * **スキルだけあって実施されないと意味がない**。Claude Code のフックに時刻駆動のイベントは無いので、
 * 契機は**時刻の周期ではなく「溜まった変更」**で作る（0.44.0）。
 *
 * 前回の全体査読（`.claude/.whole-review.json` の `lastCommit`）から HEAD までの
 *   ① 完了した機能設計書の本数（`docs/features/completed/` に増えたファイル）
 *   ② `paths.source` の差分行数（追加＋削除）
 *   ③ コミット数
 * を測り、`harness.config.json` の `wholeReview.nudge` の閾値のどれか1つ以上に達したら催促する。
 *
 * - **閾値（`wholeReview.nudge`）が無ければ何も言わない**（既存の適用先で勝手に鳴らない。fail-open）
 * - **記録が無ければ「一度も回していない」として、リポジトリの初コミットから測る**
 * - 「今回は見送る」（`--snooze`）は `snoozedAt` に HEAD を書き、そこから再び閾値ぶん溜まるまで黙る
 * - 鳴りすぎない（R3）: SessionStart で案内したら `notifiedAt` を書き、**12 時間は短縮形**にする
 *
 * 使い方:
 *   require して `nudgeLine()`（session-start-context.js）
 *   node whole-review-nudge.js            … 催促の文を標準出力へ（無ければ何も出さない・終了 0）
 *   node whole-review-nudge.js --json     … 測定値を JSON で
 *   node whole-review-nudge.js --mark [reviewFile]  … 査読せずに HEAD を記録する（手で回した直後のプロジェクト向け）
 *   node whole-review-nudge.js --snooze   … 今回は見送る
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const lib = require("./harness-lib");

const MARKER_RELATIVE_PATH = path.join(".claude", ".whole-review.json");
/** SessionStart で案内したあと、短縮形にする時間 */
const NOTIFIED_WINDOW_MS = 12 * 60 * 60 * 1000;

function markerPath() {
  return path.join(lib.projectDir(), MARKER_RELATIVE_PATH);
}

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(markerPath(), "utf-8"));
  } catch {
    return null;
  }
}

function writeMarker(next) {
  fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
  fs.writeFileSync(markerPath(), JSON.stringify(next, null, 2) + "\n");
}

/**
 * `wholeReview.nudge` の閾値を取り出す。
 *
 * @returns {{completedFeatures:number|null, sourceLines:number|null, commits:number|null}|null}
 *   キーが無い・オブジェクトでない → null（催促しない）。各値は有限の正数だけを採り、それ以外は null（その軸は見ない）
 */
function thresholdsOf(config) {
  const raw = config?.wholeReview?.nudge;
  if (!raw || typeof raw !== "object") return null;
  const pick = (k) => {
    const n = Number(raw[k]);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const t = { completedFeatures: pick("completedFeatures"), sourceLines: pick("sourceLines"), commits: pick("commits") };
  return t.completedFeatures === null && t.sourceLines === null && t.commits === null ? null : t;
}

/**
 * 測定値が閾値に達しているか（純関数。テストはここを守る）。
 *
 * @param {{completedFeatures:number, sourceLines:number, commits:number}} measured
 * @param {ReturnType<typeof thresholdsOf>} thresholds
 * @returns {string[]} 達した軸の名前（空なら催促しない）
 */
function exceededAxes(measured, thresholds) {
  if (!thresholds) return [];
  const hit = [];
  for (const k of ["completedFeatures", "sourceLines", "commits"]) {
    const t = thresholds[k];
    if (t !== null && Number(measured?.[k]) >= t) hit.push(k);
  }
  return hit;
}

/** 測る起点のコミット。`snoozedAt` → `lastCommit` → 初コミット の順 */
function baseCommit(marker) {
  const candidate = marker?.snoozedAt || marker?.lastCommit;
  // 記録のコミットが実在しないとき（rebase・別クローン）は初コミットから測る。
  // `rev-parse --verify` は 40 桁の十六進なら実在しなくても通し、`^{commit}` は cmd.exe で `^` が
  // エスケープ文字になり壊れる。`cat-file -t` が "commit" を返すかで見る
  if (candidate && /^[0-9a-f]{7,40}$/i.test(candidate) && lib.git(`cat-file -t ${candidate}`) === "commit") {
    return { commit: candidate, kind: marker?.snoozedAt ? "snoozed" : "last" };
  }
  const roots = lib.git("rev-list --max-parents=0 HEAD").split("\n").filter(Boolean);
  const first = roots[roots.length - 1];
  return first ? { commit: first, kind: "first" } : null;
}

/**
 * 起点から HEAD までを測る。
 *
 * `paths.source` のグロブは git の `:(glob)` に渡す（`harness-lib.hasSourceFiles` と同じ扱い）。
 * ブレース・角括弧を含むグロブは `:(glob)` が展開しないので、そのときは `paths.source` を使わず
 * 差分全体の行数を採る（取りこぼすより多めに数える）。
 *
 * @returns {{base:{commit:string,kind:string}, completedFeatures:number, sourceLines:number, commits:number}|null}
 */
function measure(config, marker) {
  if (lib.git("rev-parse --is-inside-work-tree") !== "true") return null;
  const base = baseCommit(marker);
  if (!base) return null;
  const range = `${base.commit}..HEAD`;

  const added = lib.git(`log --diff-filter=A --name-only --format= ${range} -- docs/features/completed/`, 10000);
  const completed = new Set(added.split("\n").map((s) => s.trim()).filter((s) => s.endsWith(".md")));

  const globs = Array.isArray(config?.paths?.source) ? config.paths.source : [];
  const usable = globs.length && !globs.some((g) => /[{}[\]]/.test(String(g)));
  const specs = usable ? globs.map((g) => `":(glob)${String(g).replace(/"/g, "")}"`).join(" ") : "";
  let sourceLines = 0;
  try {
    const stat = execSync(`git diff --shortstat ${range}${specs ? ` -- ${specs}` : ""}`, {
      cwd: lib.projectDir(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    const ins = Number((stat.match(/(\d+) insertion/) || [0, 0])[1]);
    const del = Number((stat.match(/(\d+) deletion/) || [0, 0])[1]);
    sourceLines = ins + del;
  } catch {
    sourceLines = 0;
  }

  const commits = Number(lib.git(`rev-list --count ${range}`)) || 0;
  return { base, completedFeatures: completed.size, sourceLines, commits };
}

const LABEL = { completedFeatures: "完了した設計書", sourceLines: "src の差分行", commits: "コミット" };

/**
 * 催促の1行を組み立てる。
 *
 * @param {{config?:object}|null} cfg `harness-lib.loadConfig()` の結果
 * @param {{brief?:boolean}} [opts] brief: SessionStart で案内済みなら短縮形にする
 * @returns {{line:string, measured:object, axes:string[]}|null} 催促しないときは null
 */
function nudge(cfg, opts = {}) {
  const thresholds = thresholdsOf(cfg?.config);
  if (!thresholds) return null;
  const marker = readMarker();
  const measured = measure(cfg.config, marker);
  if (!measured) return null;
  const axes = exceededAxes(measured, thresholds);
  if (!axes.length) return null;

  const since =
    measured.base.kind === "first"
      ? "一度も回していない（初コミットから）"
      : `前回 ${measured.base.commit.slice(0, 7)}` +
        (marker?.date ? `・${marker.date}` : "") +
        (measured.base.kind === "snoozed" ? "（見送り後）" : "") +
        " から";
  const figures = `完了 ${measured.completedFeatures} 本・src ±${measured.sourceLines} 行・コミット ${measured.commits}`;
  const over = axes.map((a) => LABEL[a]).join("・");

  const recentlyNotified = marker?.notifiedAt && Date.now() - Date.parse(marker.notifiedAt) < NOTIFIED_WINDOW_MS;
  const line =
    opts.brief && recentlyNotified
      ? `[全体査読] 目安に達しています（${figures}。セッション開始時に案内済み）。\`/harness-core:whole-review\``
      : `[全体査読] 目安に達しています（${since}: ${figures}。閾値を超えた軸: ${over}）。` +
        `\`/harness-core:whole-review\` で、変更単位のレビューでは拾えない横断の欠陥を全ソースから探せる。` +
        `見送るなら \`/harness-core:whole-review --snooze\`。`;
  return { line, measured, axes, recentlyNotified: Boolean(recentlyNotified) };
}

/** SessionStart 用: 催促の行を返し、出したことを記録する */
function nudgeLine(cfg) {
  const r = nudge(cfg, { brief: false });
  if (!r) return null;
  try {
    writeMarker({ ...(readMarker() || {}), notifiedAt: new Date().toISOString() });
  } catch {
    /* 記録できなくても催促は出す */
  }
  return r.line;
}

function mark(reviewFile) {
  const head = lib.git("rev-parse HEAD");
  if (!head) throw new Error("git の HEAD が取れない");
  const prev = readMarker() || {};
  const next = {
    lastCommit: head,
    date: new Date().toISOString().slice(0, 10),
    reviewFile: reviewFile || prev.reviewFile || null,
  };
  writeMarker(next);
  return next;
}

function snooze() {
  const head = lib.git("rev-parse HEAD");
  if (!head) throw new Error("git の HEAD が取れない");
  const next = { ...(readMarker() || {}), snoozedAt: head };
  delete next.notifiedAt;
  writeMarker(next);
  return next;
}

module.exports = { MARKER_RELATIVE_PATH, thresholdsOf, exceededAxes, measure, nudge, nudgeLine, mark, snooze, readMarker };

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--mark")) {
      const i = args.indexOf("--mark");
      const next = mark(args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null);
      process.stdout.write(`記録しました: ${JSON.stringify(next)}\n`);
    } else if (args.includes("--snooze")) {
      const next = snooze();
      process.stdout.write(`見送りを記録しました（${next.snoozedAt.slice(0, 7)} から再び溜まるまで黙ります）\n`);
    } else {
      const r = nudge(lib.loadConfig(), { brief: !args.includes("--full") });
      if (args.includes("--json")) {
        process.stdout.write(JSON.stringify(r ? { ...r } : null, null, 2) + "\n");
      } else if (r) {
        process.stdout.write(r.line + "\n");
      }
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[whole-review-nudge] ${e.message}\n`);
    process.exit(0); // 催促は作業を止めない
  }
}
