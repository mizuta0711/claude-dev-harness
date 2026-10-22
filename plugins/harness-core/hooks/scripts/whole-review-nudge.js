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
 * 前回の全体査読（`.claude/whole-review.json` の `lastCommit`）から HEAD までの
 *   ① 完了した機能設計書の本数（`docs/features/completed/` に増えたファイル）
 *   ② `paths.source` の差分行数（追加＋削除）
 *   ③ コミット数
 * を測り、`harness.config.json` の `wholeReview.nudge` の閾値のどれか1つ以上に達したら催促する。
 *
 * - **閾値（`wholeReview.nudge`）が無ければ何も言わない**（既存の適用先で勝手に鳴らない。fail-open）
 * - **記録が無ければ「一度も回していない」として、リポジトリの初コミットから測る**
 * - 「今回は見送る」（`--snooze`）は `snoozedAt` に HEAD を書き、そこから再び閾値ぶん溜まるまで黙る
 * - 鳴りすぎない（R3）: SessionStart（startup / resume）で案内したら `notifiedAt` を書き、
 *   **12 時間は短縮形**にする（`clear` / `compact` の SessionStart と、`pre-push-check` / `complete-feature` からの呼び出し）
 * - **記録は 2 つに分ける（0.46.0・H103）**:
 *   - `.claude/whole-review.json` … **プロジェクトの事実**（`lastCommit`・`date`・`reviewFile`）。**コミットする**。
 *     2 台で回すとき、片方が回した査読をもう片方が「初回」として催促しないため
 *     （0.44.0〜0.45.0 はマシンローカルだったので、6 日で 6 回・2 系列の全体査読が走った）
 *   - `.claude/.whole-review.local.json` … **マシンローカル**（`notifiedAt`・`snoozedAt`）。ignore する。
 *     `notifiedAt` は毎セッション書くので追跡すると差分が出続ける。見送りも個人の判断
 *   - 旧ファイル `.claude/.whole-review.json`（0.44.0〜0.45.0・ignore）は**読むだけ**: 新しい方が無ければ
 *     そこから引き継ぐ。消さない（害は無い。`--mark` すれば以後は新しい方が正）
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

/** プロジェクトの事実（コミットする）: lastCommit・date・reviewFile */
const SHARED_RELATIVE_PATH = path.join(".claude", "whole-review.json");
/** マシンローカル（ignore）: notifiedAt・snoozedAt */
const LOCAL_RELATIVE_PATH = path.join(".claude", ".whole-review.local.json");
/** 0.44.0〜0.45.0 の記録（ignore・マシンローカル）。読むだけで、書かない */
const LEGACY_RELATIVE_PATH = path.join(".claude", ".whole-review.json");
/** 後方互換のための別名（0.44.0 の export 名） */
const MARKER_RELATIVE_PATH = SHARED_RELATIVE_PATH;
/** SessionStart で案内したあと、短縮形にする時間 */
const NOTIFIED_WINDOW_MS = 12 * 60 * 60 * 1000;

function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lib.projectDir(), rel), "utf-8"));
  } catch {
    return null;
  }
}

function writeJson(rel, next) {
  const file = path.join(lib.projectDir(), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
}

const SHARED_KEYS = ["lastCommit", "date", "reviewFile"];
const LOCAL_KEYS = ["notifiedAt", "snoozedAt"];
const pickKeys = (obj, keys) => {
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  return Object.keys(out).length ? out : null;
};

/** プロジェクトの事実。新しいファイルが無ければ旧ファイルから引き継ぐ */
function readShared() {
  return pickKeys(readJson(SHARED_RELATIVE_PATH), SHARED_KEYS) ?? pickKeys(readJson(LEGACY_RELATIVE_PATH), SHARED_KEYS);
}

/** マシンローカル。新しいファイルが無ければ旧ファイルから引き継ぐ */
function readLocal() {
  return pickKeys(readJson(LOCAL_RELATIVE_PATH), LOCAL_KEYS) ?? pickKeys(readJson(LEGACY_RELATIVE_PATH), LOCAL_KEYS);
}

/** 2 つを合わせた見え方（測る側はこれだけを見る） */
function readMarker() {
  const shared = readShared();
  const local = readLocal();
  if (!shared && !local) return null;
  return { ...(shared || {}), ...(local || {}) };
}

function writeShared(next) {
  writeJson(SHARED_RELATIVE_PATH, pickKeys(next, SHARED_KEYS) || {});
}

function writeLocal(next) {
  writeJson(LOCAL_RELATIVE_PATH, pickKeys(next, LOCAL_KEYS) || {});
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

/** git の空ツリー。初コミットの中身まで数えるときの diff の起点 */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * 測る起点のコミット。`snoozedAt` → `lastCommit` → 初コミット の順に**順次**実在を確かめる
 * （`snoozedAt` だけが実在しない〔rebase 等〕とき、`lastCommit` を飛ばして初コミットへ落ちない）。
 *
 * `rev-parse --verify` は 40 桁の十六進なら実在しなくても通し、`^{commit}` は cmd.exe で `^` が
 * エスケープ文字になり壊れる。`cat-file -t` が "commit" を返すかで見る。
 */
function baseCommit(marker) {
  for (const [key, kind] of [
    ["snoozedAt", "snoozed"],
    ["lastCommit", "last"],
  ]) {
    const candidate = marker?.[key];
    if (candidate && /^[0-9a-f]{7,40}$/i.test(candidate) && lib.git(`cat-file -t ${candidate}`) === "commit") {
      return { commit: candidate, kind };
    }
  }
  // 記録が無い（または実在しない）ときは「一度も回していない」。**初コミットの中身も数える**ので、
  // 範囲は root..HEAD ではなく HEAD 全体（diff の起点は空ツリー）
  const head = lib.git("rev-parse HEAD");
  return head ? { commit: EMPTY_TREE, kind: "first" } : null;
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
  const first = base.kind === "first";
  const logRange = first ? "HEAD" : `${base.commit}..HEAD`;
  const diffRange = first ? `${EMPTY_TREE} HEAD` : `${base.commit}..HEAD`;

  // 催促は落ちてよい。SessionStart 全体（10 秒）を道連れにしないよう、git 1 回は 3 秒まで。
  // `core.quotepath=false`: 既定（Windows の git で true）だと日本語のファイル名が `"docs/.../\343\201..."` と
  // 引用符つきの八進数で出て、`.md` で終わらず 1 本も数えなかった（0.44.1。実プロジェクトで完了 0 本と誤測）
  const added = lib.git(
    `-c core.quotepath=false log --diff-filter=A --name-only --format= ${logRange} -- docs/features/completed/`,
    3000,
  );
  const completed = new Set(
    added
      .split("\n")
      .map((s) => s.trim().replace(/^"(.*)"$/, "$1"))
      .filter((s) => s.endsWith(".md")),
  );

  const globs = Array.isArray(config?.paths?.source) ? config.paths.source : [];
  // ブレース・角括弧は `:(glob)` が展開しない。`paths.source` が無いときも同じく、差分全体を採る
  const usable = Boolean(globs.length) && !globs.some((g) => /[{}[\]]/.test(String(g)));
  const specs = usable ? globs.map((g) => `":(glob)${String(g).replace(/"/g, "")}"`).join(" ") : "";
  let sourceLines = 0;
  try {
    const stat = execSync(`git diff --shortstat ${diffRange}${specs ? ` -- ${specs}` : ""}`, {
      cwd: lib.projectDir(),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    });
    const ins = Number((stat.match(/(\d+) insertion/) || [0, 0])[1]);
    const del = Number((stat.match(/(\d+) deletion/) || [0, 0])[1]);
    sourceLines = ins + del;
  } catch {
    sourceLines = 0;
  }

  const commits = Number(lib.git(`rev-list --count ${logRange}`, 3000)) || 0;
  return { base, completedFeatures: completed.size, sourceLines, sourceScoped: usable, commits };
}

/** ローカルの日付（UTC の `toISOString` だと JST の朝は前日になる） */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
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
      : measured.base.kind === "snoozed"
        ? `見送った ${measured.base.commit.slice(0, 7)} から`
        : `前回 ${measured.base.commit.slice(0, 7)}${marker?.date ? `・${marker.date}` : ""} から`;
  const linesLabel = measured.sourceScoped ? "src" : "差分（paths.source 未使用）";
  const figures = `完了 ${measured.completedFeatures} 本・${linesLabel} ±${measured.sourceLines} 行・コミット ${measured.commits}`;
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

/**
 * SessionStart 用: 催促の行を返し、出したことを記録する。
 *
 * @param {{brief?:boolean}} [opts] `clear` / `compact` では brief（12 時間以内に案内済みなら短縮形）
 */
function nudgeLine(cfg, opts = {}) {
  const r = nudge(cfg, { brief: Boolean(opts.brief) });
  if (!r) return null;
  try {
    writeLocal({ ...(readLocal() || {}), notifiedAt: new Date().toISOString() });
  } catch {
    /* 記録できなくても催促は出す */
  }
  return r.line;
}

/**
 * 査読を回した（または手で回した）ことを**プロジェクトの事実**として記録する。
 * 書くのは `.claude/whole-review.json` だけ（コミットする側）。見送り（ローカル）は消す
 * —— 回した以上、見送りの起点はもう要らない。
 */
function mark(reviewFile) {
  const head = lib.git("rev-parse HEAD");
  if (!head) throw new Error("git の HEAD が取れない");
  const prev = readShared() || {};
  const next = {
    lastCommit: head,
    date: localDate(),
    reviewFile: reviewFile || prev.reviewFile || null,
  };
  writeShared(next);
  const local = readLocal();
  if (local?.snoozedAt) {
    delete local.snoozedAt;
    writeLocal(local);
  }
  return next;
}

/** 今回は見送る。**マシンローカル**（この機械の判断。もう 1 台には効かない） */
function snooze() {
  const head = lib.git("rev-parse HEAD");
  if (!head) throw new Error("git の HEAD が取れない");
  const next = { ...(readLocal() || {}), snoozedAt: head };
  delete next.notifiedAt;
  writeLocal(next);
  return next;
}

module.exports = {
  MARKER_RELATIVE_PATH,
  SHARED_RELATIVE_PATH,
  LOCAL_RELATIVE_PATH,
  LEGACY_RELATIVE_PATH,
  thresholdsOf,
  exceededAxes,
  measure,
  nudge,
  nudgeLine,
  mark,
  snooze,
  readMarker,
  readShared,
  readLocal,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  try {
    if (args.includes("--mark")) {
      const i = args.indexOf("--mark");
      const next = mark(args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null);
      process.stdout.write(
        `記録しました: ${JSON.stringify(next)}\n` +
          `→ ${lib.toPosix(SHARED_RELATIVE_PATH)} をコミットに含めてください（プロジェクトの事実。もう 1 台にも効く）\n`,
      );
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
