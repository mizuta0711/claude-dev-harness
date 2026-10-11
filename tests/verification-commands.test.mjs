import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `verification.skill` が使うコマンドが、同じテンプレートの permissions に載っているか
 *
 * ## なぜ要るのか（H31）
 *
 * テンプレートが `verification.skill` を宣言していても、**そのスキルが実際に叩くコマンドが
 * allow / ask のどこにも無い**ことがある。実測（android）では、`capture-screenshots` が使う
 * 11コマンドのうち **allow にあったのは3つだけ**だった。
 *
 * 症状は「動作確認のたびに確認プロンプトが出る」で、**壊れてはいないので気づきにくい**。
 * しかも適用先のプロジェクトが `settings.local.json` に広い allow を持っていると、
 * **それが覆い隠す**。実測では、そのローカル設定を正しく外した瞬間に露出した。
 *
 * 移行指示書 §10-2 の機械チェックは「`verification` の**前提 MCP** が `.mcp.json` に居るか」は
 * 見るが、**必要コマンドが allow にあるか**は見ていなかった（H11 で MCP 側だけを足したため）。
 *
 * ## 判定
 *
 * SKILL.md のコードブロックから**コマンド行**を拾い、テンプレートの allow / ask の
 * どれかが覆っているかを見る。`Bash(x:*)` は前方一致、`Bash(x)` は完全一致。
 *
 * **鳴りすぎないこと**が要件（R3）。拾うのは「テンプレートが permissions で言及している
 * 実行ファイル」で始まる行だけにする。**そのテンプレートが関心を持っていないコマンドは見ない。**
 *
 * ## 同名スキルは、その環境のプラグインから解決する（H82・0.41.1 で修正）
 *
 * 以前は `listDirs("plugins")` の**先頭一致**で解決していた。`plugins/` は `harness-android` が
 * 先に来るため、`templates/wpf` の `verification.skill: capture-screenshots` は
 * **android 側の SKILL.md** に解決されていた（`plugins/harness-wpf/skills/capture-screenshots/SKILL.md`
 * は実在するのに読まれない。2026-10-11 実測）。**別環境のスキルを検査しても意味が無い**うえ、
 * 検査しているつもりで0件という状態になる。
 *
 * いまは `templates/<env>/template.json` の `plugin` を見て**その環境のプラグインを優先**し、
 * 次に `harness-core`、最後に全プラグインから探す。
 *
 * **それでも wpf は1行も検査しない。** permissions が言及する実行ファイルは `dotnet` だけで、
 * `capture-screenshots` にその行が無いためである（下の「allow で覆えない形」も参照）。
 * **解決の誤りと、覆う対象が無いことは別の問題**なので、片方を直してももう片方は残る。
 *
 * ## そもそも allow で覆えない形がある（H36・2026-10-11 実測）
 *
 * **PowerShell のドットソース行（`. "<パス>"`）は完全一致しか通らない。**
 * 前方一致もワイルドカードも効かない（`docs/reference/permissionsベースライン.md` §4 の実測表）。
 * プラグイン同梱スクリプトのパスにはユーザー名が入るため、
 * **テンプレートに書ける allow が存在しない**。wpf の `capture-screenshots` はこの形なので、
 * **この検査が将来 wpf のスキルを読めるようになっても、あの行は検査対象にならない。**
 */

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf-8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const listDirs = (rel) => {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p)
    ? fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    : [];
};

/** `Bash(adb pull:*)` → `{tool:"Bash", pattern:"adb pull", prefix:true}` */
function parseRule(rule) {
  const m = /^(Bash|PowerShell)\((.*)\)$/.exec(rule);
  if (!m) return null;
  const body = m[2];
  return body.endsWith(":*")
    ? { tool: m[1], pattern: body.slice(0, -2), prefix: true }
    : { tool: m[1], pattern: body, prefix: false };
}

/** SKILL.md のコードブロックから、`exes` のいずれかで始まる行を拾う */
function commandLines(md, exes) {
  const out = new Set();
  let inFence = false;
  for (const raw of md.split("\n")) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    // 行内コメント（`# 起動`）とリダイレクトから先は判定に使わない
    const line = raw.trim().split(/\s+#\s/)[0].split(/[>|]/)[0].trim();
    if (!line) continue;
    if (exes.some((e) => line === e || line.startsWith(`${e} `))) out.add(line);
  }
  return [...out];
}

/**
 * `templates/<env>/template.json` が名指しするプラグイン名（`harness-wpf@dev-harness` → `harness-wpf`）。
 * 無ければ null。
 */
function envPlugin(env) {
  const rel = `templates/${env}/template.json`;
  if (!exists(rel)) return null;
  const name = JSON.parse(read(rel))?.plugin;
  return typeof name === "string" ? name.split("@")[0] : null;
}

/**
 * スキルを探す順序。**同名スキルが環境ごとに存在する**（`capture-screenshots` は wpf と android に
 * 実在する）ので、**その環境のプラグインを先に見る**（H82）。
 */
function pluginSearchOrder(env) {
  const own = envPlugin(env);
  const all = listDirs("plugins");
  return [...new Set([...(own && all.includes(own) ? [own] : []), "harness-core", ...all])];
}

/**
 * スキルの実体を解決する。**下の検査はすべてこれを通す。**
 *
 * 解決した結果を `RESOLVED` に残し、**最後の検査が「どのファイルを読んだか」を見る**
 * （査読の中: ヘルパだけを検査していたため、**検査本体が別の解決に戻っても落ちなかった**）。
 */
const RESOLVED = new Map();
function resolveSkillFile(env, skill) {
  const file = pluginSearchOrder(env)
    .map((p) => `plugins/${p}/skills/${skill}/SKILL.md`)
    .find(exists);
  RESOLVED.set(env, { skill, file });
  return file;
}

const ENVS = listDirs("templates").filter((e) =>
  exists(`templates/${e}/.claude/harness.config.json`)
);

test("verification.skill が使うコマンドは、そのテンプレートの allow / ask に載っている", () => {
  const problems = [];
  let checked = 0;

  for (const env of ENVS) {
    const cfg = JSON.parse(read(`templates/${env}/.claude/harness.config.json`));
    const skill = cfg?.verification?.skill;
    if (!skill) continue;

    // スキルの実体を探す。**その環境のプラグインを優先する**（H82）
    const skillFile = resolveSkillFile(env, skill);
    assert.ok(
      skillFile,
      `templates/${env} が verification.skill: ${skill} を宣言しているが、実体が見つからない`
    );

    const settings = JSON.parse(read(`templates/${env}/.claude/settings.json`));
    const perms = settings?.permissions ?? {};
    const rules = [...(perms.allow ?? []), ...(perms.ask ?? [])].map(parseRule).filter(Boolean);

    // このテンプレートが permissions で言及している実行ファイルだけを対象にする
    const exes = [...new Set(rules.map((r) => r.pattern.split(/\s+/)[0]))].filter((e) =>
      /^[a-z][a-z0-9.-]*$/.test(e)
    );
    if (!exes.length) continue;

    for (const line of commandLines(read(skillFile), exes)) {
      checked++;
      const covered = rules.some((r) =>
        r.prefix ? line === r.pattern || line.startsWith(`${r.pattern} `) : line === r.pattern
      );
      if (!covered) problems.push(`${env} / ${skill}: ${line}`);
    }
  }

  assert.ok(checked > 0, "1件も検査していない。抽出の条件が壊れている可能性がある");
  assert.deepEqual(
    problems,
    [],
    "verification.skill が使うのに allow / ask に無いコマンド:\n  " +
      problems.join("\n  ") +
      "\n\n毎回確認プロンプトが出る。壊れてはいないので気づきにくい（H31）"
  );
});

/**
 * `harness.config.json` の `commands.*` が、そのテンプレートの allow / ask に載っているか
 *
 * ## なぜ要るのか（2026-10-11・nextjs 束の査読）
 *
 * `commands.*` と `permissions.allow` の対応は**手で合わせているだけ**だった。
 * 上の検査は `verification.skill` の SKILL.md しか見ないので、
 * **`commands.typecheck` を書き換えて allow の追従を落としても、何も落ちない**。
 *
 * 実際に落ちた: `npx tsc --noEmit` を `npx --no-install next typegen && npx tsc --noEmit` へ
 * 変えたとき、allow は `Bash(npx next typegen:*)`（`--no-install` の無い形）のままだった。
 * **ゲートは通るが、コマンドのたびに確認が出る**（H31 と同じ「壊れてはいないので気づきにくい」）。
 *
 * ## 判定
 *
 * `commands.*` の値を `&&` / `||` / `;` / `|` で分割し、**各セグメントの先頭が
 * テンプレートの permissions に載っている実行ファイル**なら、allow / ask が覆っているかを見る。
 * **鳴りすぎないこと**は上の検査と同じ条件で担保する（言及の無い実行ファイルは見ない）。
 */
test("harness.config.json の commands は、そのテンプレートの allow / ask に載っている", () => {
  const problems = [];
  let checked = 0;

  for (const env of ENVS) {
    const cfg = JSON.parse(read(`templates/${env}/.claude/harness.config.json`));
    const settings = JSON.parse(read(`templates/${env}/.claude/settings.json`));
    const perms = settings?.permissions ?? {};
    const rules = [...(perms.allow ?? []), ...(perms.ask ?? [])].map(parseRule).filter(Boolean);
    const exes = [...new Set(rules.map((r) => r.pattern.split(/\s+/)[0]))].filter((e) =>
      /^[a-z][a-z0-9.-]*$/.test(e)
    );
    if (!exes.length) continue;

    for (const [name, value] of Object.entries(cfg?.commands ?? {})) {
      if (!value) continue;
      // `dev` は対象外。**ハーネスは実行しない**（`docs/reference/harness設定契約.md` の
      // commands の行が「`dev` は実行しない」と明記している）。人が起動するものなので、
      // 許可は各プロジェクトの settings.local.json に任せる
      if (name === "dev") continue;
      // 複合コマンドはセグメントごとに許可が要る（ツール側が操作単位で照合する）
      for (const seg of value.split(/&&|\|\||;|\|/)) {
        const line = seg.trim();
        if (!line) continue;
        const head = line.split(/\s+/)[0];
        if (!exes.includes(head)) continue; // 関心の外（鳴りすぎ防止）
        checked++;
        const covered = rules.some((r) =>
          r.prefix ? line === r.pattern || line.startsWith(`${r.pattern} `) : line === r.pattern
        );
        if (!covered) problems.push(`${env} / commands.${name}: ${line}`);
      }
    }
  }

  assert.ok(checked > 0, "1件も検査していない。抽出の条件が壊れている可能性がある");
  assert.deepEqual(
    problems,
    [],
    "commands に書いてあるのに allow / ask に無いコマンド:\n  " +
      problems.join("\n  ") +
      "\n\nゲートは通るが毎回確認プロンプトが出る（H31 と同型）"
  );
});

/**
 * `verification.skill` の解決先は、その環境のプラグインである（H82）
 *
 * 先頭一致で解決していたときは、**wpf が android のスキルを読んでいた**（2026-10-11 実測）。
 * 上の2つの検査は「覆えていないコマンド」が無ければ通るので、
 * **間違ったファイルを読んでいても落ちない**。解決そのものをここで固定する。
 */
test("verification.skill は、その環境のプラグインの SKILL.md に解決する", () => {
  // **上の検査が実際に読んだファイル**を見る（ヘルパを呼び直すと、検査本体が別の解決へ
  // 戻っても落ちない。査読の中）
  assert.ok(RESOLVED.size > 0, "上の検査が1件もスキルを解決していない（順序が変わった可能性がある）");
  let checked = 0;
  for (const [env, { skill, file }] of RESOLVED) {
    const own = envPlugin(env);
    const ownFile = `plugins/${own}/skills/${skill}/SKILL.md`;
    if (!own || !exists(ownFile)) continue; // core 側のスキルを使う環境
    checked++;
    assert.equal(file, ownFile, `${env}: 別環境のスキルを読んでいる`);
  }
  assert.ok(checked > 0, "1件も検査していない。環境のプラグインに同名スキルが無い可能性がある");
});
