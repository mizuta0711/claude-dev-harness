/**
 * SessionStart フック: セッション開始時に現在の状況と config の健全性を注入する
 *
 * matcher: startup|resume|clear|compact（`hooks.json` と一致させること）
 *
 * 毎回ユーザーが「今どこまで進んでいるか」を説明しなくて済むように、
 * ブランチ・未プッシュ数・未コミット数・進行中の機能設計書・次にやることを additionalContext に載せる。
 *
 * harness-core は .claude/harness.config.json を契約として動くため、
 * **このフックだけは config 不在・不正を警告する**（他の hook は黙って素通りする / 04仕様 §4-1）。
 *
 * source === "compact" の場合は pre-compact-save.js が退避した
 * .claude/.session-context.json を読み戻し、コンパクトで失われた文脈を復元する。
 *
 * すべての取得は失敗しても落とさない（情報提示が目的であり、作業を止めてはいけない）。
 */
const fs = require("fs");
const path = require("path");
const lib = require("./harness-lib");

const SAVE_FILE = path.join(lib.projectDir(), ".claude", ".session-context.json");

/** docs/features/ 直下の進行中設計書を、メタ情報の全体ステータス付きで列挙する */
/**
 * `docs/handoff/` に受け取り待ちの引き継ぎがあるか。
 *
 * **備忘のための通知であって、これが拘束力の本体ではない**（本体は `receive-handoff` スキル）。
 * handoff へ入れるのはユーザーの指示なので、呼ぶ契機はユーザー自身が持っている。
 */
function pendingHandoffs() {
  const dir = path.join(lib.projectDir(), "docs", "handoff");
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * 台帳（docs/backlog.md）の「計画」の表の先頭行＝**次に進めるもの**。
 *
 * **台帳は読まれないと意味が無い。** セッションをまたぐと「次は何か」が分からなくなる。
 * 表の1行目だけを出す（全部出すと長い。詳細は台帳を読む）。
 *
 * ## 見出しは「計画」と「マイルストーン」の両方を受け付ける
 *
 * 0.30.0 で表の役割を広げ（**設計書を伴う作業すべての順序**。単発の1本も載る）、
 * 見出しを「計画」に改めた。**既存プロジェクトの台帳は「マイルストーン」のまま**なので、
 * 両方を見る。移行を強いない（fail-open と同じ方針）。
 *
 * ## 走査は「区切り行の直後」から始める
 *
 * **ヘッダ行や区切り行を拾わないための要点。** 初版は1列目が `#` かどうかと `/^-+$/` で
 * 判定していたが、**標準の Markdown で普通に書かれる形で9パターン誤動作した**（査読の実測）:
 * 位置揃えの区切り（`|:--|---:|`）／ヘッダが `| No |`／番号列が無い表／
 * コードフェンスや HTML コメントの中にある書式例の表。
 *
 * **区切り行（全セルが `:?-+:?`）を見つけ、その次の行から探す**ことで、
 * 列の名前にも番号の有無にも依存しなくなる。
 */
function nextMilestone() {
  let lines;
  try {
    lines = fs.readFileSync(path.join(lib.projectDir(), "docs", "backlog.md"), "utf-8").split("\n");
  } catch {
    return null; // 台帳が無ければ何も出さない（fail-open）
  }

  // コードフェンスと HTML コメントの中は読まない（書式の例が置かれている）
  const live = [];
  let inFence = false;
  let inComment = false;
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) {
      inFence = !inFence;
      live.push("");
      continue;
    }
    if (!inFence && l.includes("<!--")) inComment = true;
    const hidden = inFence || inComment;
    if (!inFence && inComment && l.includes("-->")) inComment = false;
    live.push(hidden ? "" : l);
  }

  const isSeparator = (l) =>
    /^\s*\|/.test(l) &&
    l
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .every((c) => /^\s*:?-+:?\s*$/.test(c));

  // **候補の見出しを全部試す。** 最初の1つだけを見ると2つの壊れ方をする（査読で実測）:
  //   ①`## 今後の計画` のような**別の見出しを誤って拾い**、間違った行を自信たっぷりに出す
  //   ②テンプレート追従の途中で「計画」（空）と「マイルストーン」（行あり）が併存すると、
  //     空の方だけを見て**黙って何も出さなくなる**
  //
  // **「計画」は行頭に錨を打つ。** 日本語の台帳には `## 今後の計画` `## リリース計画` が
  // 普通に出てくるので、部分一致にすると**本物の表より先にそちらを拾う**（実測で再現）。
  // 一方 `マイルストーン` は 0.27.0 から前置修飾（`## 開発マイルストーン`）を許しており、
  // **既存プロジェクトがそう書いている可能性がある**ので緩いままにする。
  // 錨を打った方を先に試し、見つからなければ緩い方へ落ちる。
  const strict = (l) => /^#{1,6} +(計画|マイルストーン)(\s|（|\(|:|：|$)/.test(l);
  const loose = (l) => /^#{1,6} /.test(l) && l.includes("マイルストーン");
  const pick = (f) => live.map((l, i) => (f(l) ? i : -1)).filter((i) => i >= 0);
  const heads = [...pick(strict), ...pick(loose).filter((i) => !strict(live[i]))];
  if (!heads.length) return null;

  for (const head of heads) {
    const row = firstRowAfter(live, head, isSeparator);
    if (row) return row;
  }
  return null;
}

/** 見出し `head` の節にある表の、区切り行より後の最初の中身のある行。無ければ null。 */
function firstRowAfter(live, head, isSeparator) {
  let sep = -1;
  for (let i = head + 1; i < live.length; i++) {
    if (/^#{1,6} /.test(live[i])) break; // 次の見出しまで
    if (isSeparator(live[i])) {
      sep = i;
      break;
    }
  }
  if (sep < 0) return null;

  for (let i = sep + 1; i < live.length; i++) {
    if (/^#{1,6} /.test(live[i])) break;
    const cells = live[i].match(/^\s*\|(.*)\|\s*$/);
    if (!cells) continue;
    const cols = cells[1].split("|").map((c) => c.trim());
    const name = cols.find((c, k) => k > 0 && c) || (cols[0] ? cols[0] : "");
    if (!name) continue; // 空行
    const num = cols[0] && cols[0] !== name ? `${cols[0]}. ` : "";
    // **完了印が残っていたら、それ自体を知らせる。** 台帳は進捗を持たない設計なので、
    // 行の削除が唯一の進行信号である（消し忘れると古い先頭行を出し続ける）。
    if (/✅|完了/.test(live[i])) return `${num}${name}  ⚠️ 台帳に完了印が残っている（完了した行は消す）`;
    return `${num}${name}`;
  }
  return null;
}

/**
 * 進行中の機能設計書を列挙する。
 *
 * **直下（本実装・作業中）と `prototype/`（試作・作業中）の両方を見る**（H76）。
 * 直下だけを見ていたため、**試作の設計書はセッションをまたいだ瞬間に見えなくなっていた**
 * （設計の査読が指摘した。`pre-compact-save.js` も同じ形で直してある）。
 *
 * 着手前（`planned/`）・保留（`pending/`）・完了（`completed/`）は**進行中ではない**ので見ない。
 */
function activeFeatureDocs() {
  const base = path.join(lib.projectDir(), "docs", "features");
  const filesIn = (sub) => {
    const dir = sub ? path.join(base, sub) : base;
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "TEMPLATE.md")
        .map((e) => (sub ? path.join("docs", "features", sub, e.name) : path.join("docs", "features", e.name)));
    } catch {
      return [];
    }
  };

  return [...filesIn(null), ...filesIn("prototype")]
    .map((file) => {
      let status = "";
      try {
        // メタ情報テーブルの「全体ステータス」行だけを見る（全文読みは不要）
        const head = fs
          .readFileSync(path.join(lib.projectDir(), file), "utf-8")
          .split("\n")
          .slice(0, 40)
          .join("\n");
        const m = head.match(/\|\s*全体ステータス\s*\|\s*([^|]+?)\s*\|/);
        if (m) status = m[1];
        // Stage 2 をフェーズごとに書いた設計書では、どこまで確定したかが
        // 「Stage 2」行にしか無い。セッションをまたぐと次に設計するフェーズが
        // 分からなくなるため、Phase を含むときだけ併記する。
        const s2 = head.match(/\|\s*Stage 2[^|]*\|\s*([^|]+?)\s*\|/);
        if (s2 && /Phase/.test(s2[1])) status = `${status} / Stage 2: ${s2[1]}`;
      } catch {
        /* 読めなければステータスなしで列挙する */
      }
      return { file: lib.toPosix(file), status };
    })
    .filter((d) => !/🟢|完了/.test(d.status));
}

const input = lib.readPayload() || {};
const lines = [];

// --- config の健全性チェック（harness-core の前提） ---
const cfg = lib.loadConfig();
if (cfg.status === "ok") {
  const env = cfg.config?.environment || "(environment 未設定)";
  lines.push(`[harness] environment: ${env} / schemaVersion: ${cfg.config.schemaVersion}`);
} else {
  lines.push(`[harness] ⚠️ ${cfg.message}`);
  if (cfg.status === "missing") {
    lines.push(
      "  → build-check / update-docs / pre-commit ゲート等は設定不在として動作します。" +
        "テンプレートから harness.config.json を配置してください。"
    );
  }
}

// --- git の状況 ---
//
// ⚠️ **upstream が無いブランチで黙らないこと。**
// かつては `@{upstream}..HEAD` だけを見ていたが、これは upstream が設定されている
// ブランチでしか値を返さない。**エージェントが自動で切ったブランチには upstream が無い**ため、
// 「ユーザーが知らないブランチに未プッシュのコミットが積み上がっている」という
// **最も知らせるべき状況でだけ、未プッシュ数の行ごと消えていた**（2026-08-16 実測。
// 実プロジェクトで 4 コミットが約 20 時間気づかれずに残った）。
// upstream が無い場合はリモートの既定ブランチを基準にして数え、**その旨を明示する**。
const branch = lib.git("branch --show-current", 3000);
const dirty = lib.git("status --porcelain", 3000);

const upstream = lib.git("rev-parse --abbrev-ref @{upstream}", 3000);
const defaultRef = lib.git("symbolic-ref --short refs/remotes/origin/HEAD", 3000);

let ahead = "";
let aheadLabel = "未プッシュ";
let orphanBranch = false;

if (upstream) {
  ahead = lib.git("rev-list --count @{upstream}..HEAD", 3000);
} else if (defaultRef) {
  // upstream 未設定。既定ブランチに無いコミットを数える
  ahead = lib.git(`rev-list --count ${defaultRef}..HEAD`, 3000);
  aheadLabel = `${defaultRef} に無い`;
  orphanBranch = Boolean(ahead && ahead !== "0");
}

const head = [];
if (branch) head.push(`branch: ${branch}${upstream ? "" : "（upstream 無し）"}`);
if (ahead && ahead !== "0") head.push(`${aheadLabel}: ${ahead} commits`);
if (dirty) head.push(`未コミット: ${dirty.split("\n").length} ファイル`);
if (head.length) lines.push(`[状況] ${head.join(" / ")}`);

if (orphanBranch) {
  lines.push(
    `  → **このブランチは push されていない。** ${defaultRef} に無いコミットが ${ahead} 件ある。` +
      `ユーザーが把握していない可能性があるため、作業を始める前に扱い` +
      `（push / 既定ブランチへマージ / ローカル維持）を確認すること。`
  );
}

/**
 * 前回の利用実績監査（`/harness-core:usage-audit`）からの経過日数
 *
 * **知らせるだけ。止めない。** 監査は「配ったのに動いていない仕組み」を見つける工程で、
 * 実測するまで誰も気づかない種類の欠陥を扱う（**動かなくても何も起きない**ため）。
 * 思い出して叩く運用にすると回らないので、**経過を画面に出す**。
 *
 * - マーカーがあれば `lastRunAt` から数える
 * - **マーカーが無い場合は `harness-baseline.json` の `appliedAt` から数える**
 *   （導入直後のプロジェクトに「監査していません」と出しても意味が無いため、
 *    間隔を過ぎるまでは黙る）
 * - 判定に必要なものが無ければ **null（何も言わない）**
 */
function auditOverdueDays(intervalDays) {
  const read = (rel) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(lib.projectDir(), rel), "utf-8"));
    } catch {
      return null;
    }
  };
  const marker = read(path.join(".claude", ".harness-audit.json"));
  const base = marker?.lastRunAt || read(path.join(".claude", "harness-baseline.json"))?.appliedAt;
  if (!base) return null;
  const since = Date.parse(base);
  if (Number.isNaN(since)) return null;
  const days = Math.floor((Date.now() - since) / 86400000);
  return days > intervalDays ? { days, everRun: Boolean(marker?.lastRunAt) } : null;
}

/**
 * 前回のテンプレート層の追従（`/harness-core:harness-update`）からの経過日数
 *
 * **知らせるだけ。止めない。** プラグイン層は marketplace が運ぶが、
 * **テンプレート層（CLAUDE.md / rules / config / docs 骨格）は生成時のコピー**なので、
 * 追従を叩かない限り改善が届かない。**届いていないことに症状が出ない**ので気づけない。
 *
 * 前回日は `harness-baseline.json` の `appliedAt`。`harness-diff.mjs` の `finalize` が
 * 追従のたびに更新するため、**専用のマーカーは要らない**（生成直後は生成日が入る）。
 */
function templateFollowOverdueDays(intervalDays) {
  let base;
  try {
    base = JSON.parse(
      fs.readFileSync(path.join(lib.projectDir(), ".claude", "harness-baseline.json"), "utf-8")
    )?.appliedAt;
  } catch {
    return null;
  }
  if (!base) return null;
  const since = Date.parse(base);
  if (Number.isNaN(since)) return null;
  const days = Math.floor((Date.now() - since) / 86400000);
  return days > intervalDays ? days : null;
}

const AUDIT_INTERVAL_DEFAULT = 30;
// ⚠️ `Number(x) || 既定` と書くと **`0` が既定に化けて無効化できない**（実測で踏んだ）。
//    `0` は「通知しない」という**意味のある値**なので、有限数かどうかで分岐する。
const auditIntervalRaw = Number(cfg.config?.audit?.intervalDays);
const auditInterval = Number.isFinite(auditIntervalRaw) ? auditIntervalRaw : AUDIT_INTERVAL_DEFAULT;
const overdue = cfg.status === "ok" && auditInterval > 0 ? auditOverdueDays(auditInterval) : null;
if (overdue) {
  lines.push(
    `[利用実績の監査] 前回から ${overdue.days} 日` +
      (overdue.everRun ? "" : "（まだ一度も実施していない）") +
      `。\`/harness-core:usage-audit\` で、配ったのに動いていない仕組みと規律の遵守を実測できる。`
  );
}

const UPDATE_INTERVAL_DEFAULT = 30;
// `audit.intervalDays` と同じ扱い。`0` は「通知しない」という意味のある値なので有限数で分岐する
const updateIntervalRaw = Number(cfg.config?.update?.intervalDays);
const updateInterval = Number.isFinite(updateIntervalRaw)
  ? updateIntervalRaw
  : UPDATE_INTERVAL_DEFAULT;
const followOverdue =
  cfg.status === "ok" && updateInterval > 0 ? templateFollowOverdueDays(updateInterval) : null;
if (followOverdue) {
  lines.push(
    `[テンプレート層の追従] 前回から ${followOverdue} 日` +
      `。\`/harness-core:harness-update\` で CLAUDE.md / rules / config / docs 骨格を最新へ追従できる` +
      `（差分はファイル単位で承認を取る）。**プラグイン層とは経路が別**で、` +
      `\`/plugin\` の更新では新しくならない。`
  );
}

const handoffs = pendingHandoffs();
if (handoffs.length) {
  lines.push(
    `[引き継ぎ] docs/handoff/ に ${handoffs.length}件: ${handoffs.join(", ")}` +
      `。\`/harness-core:receive-handoff\` で裏取り・仕分けして所定のフォルダへ移せる` +
      `（handoff は受け渡し専用で、作業場所ではない）。`
  );
}

const docs = activeFeatureDocs();
if (docs.length) {
  lines.push("[進行中の機能設計書]");
  for (const d of docs) {
    lines.push(`  - ${d.file}${d.status ? ` (${d.status})` : ""}`);
  }
}

const next = nextMilestone();
if (next) lines.push(`[次にやること] ${next}（順序＝優先順位。docs/backlog.md が正）`);

// コンパクト直後は、退避しておいた文脈を復元する
if (input.source === "compact") {
  try {
    const saved = JSON.parse(fs.readFileSync(SAVE_FILE, "utf-8"));
    if (saved?.note) lines.push(`[コンパクト前の作業] ${saved.note}`);
    if (Array.isArray(saved?.activeFeatureDocs) && saved.activeFeatureDocs.length) {
      lines.push(`[コンパクト前の設計書] ${saved.activeFeatureDocs.join(", ")}`);
    }
    fs.unlinkSync(SAVE_FILE);
  } catch {
    /* 退避ファイルが無い・壊れている場合は無視する */
  }
}

if (!lines.length) process.exit(0);

/**
 * 画面には**1行だけ**出す（#23）。
 *
 * SessionStart の `systemMessage` は画面に出ることが実測で分かったが、
 * 状況の詳細（未プッシュ数・進行中の設計書・コンパクト前の文脈）は
 * **Claude が使うための情報**であって、毎回の起動で人に読ませるものではない。
 * 人が知りたいのは **「ハーネスが載っているか」**の一点なので、そこだけを出す。
 *
 * これで「導入できたのか分からない」（C1 のつまずき）が起動時に解消する。
 * 設定不在の警告は**見逃されると全機能が黙って素通りする**ため、画面にも出す。
 */
// **例外がひとつある。** 「push されていないブランチの上にいる」ことだけは画面にも出す。
// 気づかないまま作業を重ねると、コミットが増えるほど始末が難しくなる種類の問題であり、
// Claude の文脈にだけ入れても人には届かない。
const screen =
  cfg.status === "ok"
    ? `[harness] ${cfg.config?.environment || "environment 未設定"} / config OK` +
      (orphanBranch ? ` ⚠️ ブランチ \`${branch}\` は未 push（${defaultRef} に無いコミット ${ahead} 件）` : "") +
      // 監査は**人が起動を決める**ものなので、Claude の文脈だけでなく画面にも出す
      (overdue ? ` 💡 利用実績の監査から ${overdue.days} 日（/harness-core:usage-audit）` : "")
    : `[harness] ⚠️ ${cfg.message}`;

lib.emit({
  systemMessage: screen,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: lines.join("\n"),
  },
});
