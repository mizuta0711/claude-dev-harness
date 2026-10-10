#!/usr/bin/env node
/**
 * `.claude/rules/` が実物と食い違っていないかを機械で検査する（H27）。
 *
 * 移行指示書 §10-2 は `rules/` の突き合わせを「機械では検出できない」としていたが、
 * 少なくとも次の2つは検出できる。
 *
 *   A. paths が1件も一致しない（規約が一度もロードされない。静かに失敗する）
 *   B. 本文が名指しした API・識別子が、ソースにも依存の宣言にも無い
 *
 * なぜ機械に任せるのか（実測・android を1本適用）:
 * hiltViewModel()（DI 未導入）/ collectAsStateWithLifecycle()（依存なし）/
 * 「domain は Android SDK に依存しない」（22箇所で違反）/「remember { ViewModel } しない」（12箇所で違反）
 * の4件が出たが、査読が入るまで1件も気づけなかった。
 *
 * B は「実在しない」とまでは言えない。名前の付け方・生成コード・文書だけの言及で
 * 外れることがあるので、「確かめるべき候補」として出す。
 * 鳴りすぎる安全弁は外される（R3）ので、候補の拾い方は保守的に倒してある。
 *
 * 使い方:
 *   node <harness>/tools/rules-reality-check.mjs [--project <dir>] [--json]
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * glob を正規表現へ。**波括弧の展開に対応している。**
 *
 * 対応しないと `src/**` + `/*.{ts,tsx}` の形が1件も一致せず、
 * **「この規約は一度もロードされない」と誤報告する**（実測: 実プロジェクトで出た）。
 * テンプレート自身がこの書き方を配っているので、**外せない**。
 */
export function globToRegExp(glob) {
  const SPECIAL = ".+^$()|[]";
  let out = "";
  for (const ch of String(glob)) {
    out += SPECIAL.includes(ch) ? "\\" + ch : ch;
  }
  // 波括弧を選択へ（`{ts,tsx}` → `(?:ts|tsx)`）
  out = out.replace(/\{([^{}]*)\}/g, (_, inner) =>
    "(?:" + inner.split(",").map((x) => x.trim()).join("|") + ")"
  );
  // `**` はディレクトリをまたぐ。`*` はまたがない。**正規表現を使わずに置き換える**
  // **`**` + `/` は0階層にも一致させる。** させないと `src/**` + `/*.ts` が `src/a.ts` に
  // 当たらず、**誤って「一度もロードされない」と断定する**（査読 中5）。
  out = out
    .split("**/").join("\u0001")
    .split("**").join("\u0000")
    .split("*").join("[^/]*")
    .split("\u0001").join("(?:.*/)?")
    .split("\u0000").join(".*");
  return new RegExp("^" + out + "$");
}

/** frontmatter の paths を読む */
export function parsePaths(markdown) {
  // **BOM を落とす**（付いていると frontmatter の `---` に一致しない。査読 中6）
  const text = String(markdown || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return [];

  /** 引用符と行末コメントを落とす。**落とさないと glob として使えない**（査読 中6） */
  const clean = (raw) => {
    let v = raw.trim().replace(/\s+#.*$/, "").trim();
    const q = v.slice(0, 1);
    if ((q === String.fromCharCode(34) || q === "'") && v.endsWith(q)) v = v.slice(1, -1);
    return v.trim();
  };

  const out = [];
  let inPaths = false;
  for (const line of m[1].split("\n")) {
    // インライン配列（`paths: ["a", "b"]`）にも対応する
    const inline = /^paths:\s*\[(.*)\]\s*$/.exec(line);
    if (inline) {
      for (const part of inline[1].split(",")) {
        const v = clean(part);
        if (v) out.push(v);
      }
      inPaths = false;
      continue;
    }
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const item = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (item) {
        const v = clean(item[1]);
        if (v) out.push(v);
        continue;
      }
      if (/^\S/.test(line)) inPaths = false;
    }
  }
  return out;
}

/** 無視するディレクトリ（巨大・生成物） */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".next", "dist", "build", "out", "bin", "obj",
  "Library", "Temp", "Logs", ".gradle", ".idea", ".vs", "vendor",
  "__pycache__", ".venv", "coverage", ".claude",
]);

export function listFiles(root, base = root, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      listFiles(path.join(root, e.name), base, out);
    } else {
      out.push(path.relative(base, path.join(root, e.name)).split(path.sep).join("/"));
    }
  }
  return out;
}

/**
 * 言語のキーワードと汎用語。拾うと誤検出になる。
 */
const GENERIC = new Set([
  "if", "for", "while", "return", "new", "throw", "catch", "try", "function", "class",
  "import", "export", "await", "async", "const", "let", "var", "when", "fun", "val",
  "get", "set", "map", "filter", "forEach", "then", "toString", "equals", "hashCode",
  "console.log", "require", "describe", "test", "expect",
]);

/**
 * 本文から「確かめるべき識別子」を拾う。保守的に倒してある。
 *
 * 拾うのはコードスパンの中だけで、さらに呼び出しの形（foo() / Foo.bar()）と注釈（@X）に限る。
 * パス・glob・拡張子つき・空白を含むもの（コマンド）は拾わない。
 */
/**
 * 否定・禁止の言い方。**この文脈の識別子は候補にしない。**
 *
 * **禁止の規約は、禁止する対象の名前を本文に書く。** そのため
 * **規約が正しいほど B に引っかかる**（査読で指摘された構造的な欠陥）。
 *
 * > 実測（Android の実プロジェクト）: 初版は3件報告したが**全部誤報**だった ——
 * > 「DI は導入していないので `hiltViewModel()` は**使えない**」
 * > 「`collectAsStateWithLifecycle()` は … **入れていないため使えない**」
 * > 「`fallbackToDestructiveMigration()` は利用者のデータを**消す**ので … **限る**」。
 * > **3件とも、査読の指摘を受けて直したあとの正しい文面**である。
 * > 適用時の文面（`49f2058`）は「ViewModel は `viewModel()` / `hiltViewModel()` で**取得する**」で、
 * > **そちらが H27 の欠陥**だった。否定を外さないと、**直す前と直した後を区別できない**。
 */
const NEGATIVE = [
  "使えない", "使わない", "使用しない", "使うな", "避ける", "禁止", "非推奨",
  "導入していない", "入れていない", "しない", "せず", "ではなく", "代わりに",
  "に限る", "消す", "選択肢にならない", "できない", "やめる", "外す", "不要",
];

/** その行が否定・禁止の文脈か */
export function isNegativeContext(line) {
  return NEGATIVE.some((w) => String(line).includes(w));
}

/**
 * 本文を**文**へ切る。
 *
 * **行でも箇条書きの項目でも粗すぎる。** 否定は識別子と同じ文に現れるが、
 * **隣の文には別の識別子についての否定がある**。
 *
 * > 実測（Android の実プロジェクトへ適用したときの文面）:
 * > 「ViewModel は `viewModel()` / `hiltViewModel()` で**取得する**。」の**次の行**が
 * > 「自分で `remember { MyViewModel() }` **しない**」だった。
 * > 行や項目で見ると、**この否定が `hiltViewModel` に掛かっていると誤って読み**、
 * > **本物の欠陥を落とす**（実測で落とした）。
 */
export function toSentences(markdown) {
  const src = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  // 折り返しの行を前の行へ畳む（箇条書き・見出し・表・空行は新しい塊の始まり）
  const items = [];
  for (const line of src) {
    const starts = /^\s*(?:[-*+]\s|\d+\.\s|#|\||>|```|\s*$)/.test(line);
    if (starts || !items.length) items.push(line);
    else items[items.length - 1] += " " + line;
  }
  // 句点で文へ切る
  return items.flatMap((item) => item.split("。"));
}

export function extractIdentifiers(markdown) {
  const found = new Set();
  for (const sentence of toSentences(markdown)) {
    if (isNegativeContext(sentence)) continue;
    collectFromLine(sentence, found);
  }
  return [...found].sort();
}

function collectFromLine(line, found) {
  for (const m of line.matchAll(/`([^`\n]+)`/g)) {
    const span = m[1].trim();
    if (!span || /\s/.test(span)) continue;
    if (span.includes("/") || /\.(md|json|ts|tsx|kt|cs|xaml|js|mjs|yml|yaml)$/.test(span)) continue;
    const call = /^(@?[A-Za-z_][\w.]*)\s*\(/.exec(span);
    const annotation = /^@([A-Za-z_]\w*)$/.exec(span);
    const name = call ? call[1] : annotation ? "@" + annotation[1] : null;
    if (!name) continue;
    const bare = name.replace(/^@/, "");
    if (GENERIC.has(bare) || GENERIC.has(name)) continue;
    if (bare.length < 4) continue;
    found.add(name);
  }
}

/** 依存の宣言ファイルの中身（まとめて1本の文字列にする） */
export function readManifests(projectDir, files) {
  const fixed = [
    "package.json", "build.gradle", "build.gradle.kts", "settings.gradle",
    "settings.gradle.kts", "gradle/libs.versions.toml", "Directory.Packages.props",
    "packages.config", "requirements.txt", "pyproject.toml", "Packages/manifest.json",
  ];
  const read = (rel) => {
    try {
      return fs.readFileSync(path.join(projectDir, rel), "utf-8") + "\n";
    } catch {
      return "";
    }
  };
  let text = fixed.map(read).join("");
  for (const f of files || listFiles(projectDir)) {
    if (/(^|\/)(build\.gradle(\.kts)?|[^/]+\.csproj)$/.test(f)) text += read(f);
  }
  return text;
}

const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|kt|kts|java|cs|xaml|axaml|py|swift|go|rs|vue|svelte)$/;

/**
 * 検査する。
 *
 * @returns {{applicable: boolean, reason?: string, pathsFindings: Array, apiFindings: Array}}
 */
export function check(projectDir) {
  const rulesDir = path.join(projectDir, ".claude", "rules");
  let ruleFiles;
  try {
    ruleFiles = fs.readdirSync(rulesDir).filter((f) => f.endsWith(".md"));
  } catch {
    return { applicable: false, reason: ".claude/rules/ が無い", pathsFindings: [], apiFindings: [] };
  }
  if (!ruleFiles.length) {
    return { applicable: false, reason: ".claude/rules/ が空", pathsFindings: [], apiFindings: [] };
  }

  const files = listFiles(projectDir);
  const sourceFiles = files.filter((f) => SOURCE_EXT.test(f));
  if (!sourceFiles.length) {
    return {
      applicable: false,
      reason: "ソースファイルが1つも無い（未初期化）",
      pathsFindings: [],
      apiFindings: [],
    };
  }

  const manifests = readManifests(projectDir, files);
  let sourceText = "";
  for (const f of sourceFiles) {
    try {
      sourceText += fs.readFileSync(path.join(projectDir, f), "utf-8");
    } catch {
      /* 読めなければ飛ばす */
    }
  }

  const pathsFindings = [];
  const apiFindings = [];

  for (const name of ruleFiles.sort()) {
    const body = fs.readFileSync(path.join(rulesDir, name), "utf-8");

    const globs = parsePaths(body);
    if (globs.length) {
      const matched = globs.filter((g) => {
        const re = globToRegExp(g);
        return files.some((f) => re.test(f));
      });
      if (!matched.length) {
        pathsFindings.push({
          rule: name,
          globs,
          why:
            "この規約は一度もロードされない（paths が実構成に1件も一致しない）。" +
            "エラーは出ないので静かに失敗する。実構成に合わせて paths を直す。",
        });
      }
    }

    const unknown = extractIdentifiers(body).filter((id) => {
      // **ドット付きは最後の区切りで照合する。** `Modifier.imePadding` は
      // 実装側では `Modifier` に続けて `.imePadding` と書かれ、
      // **その文字列のままでは出てこない**ことがある（実測で誤検出した）。
      const bare = id.replace(/^@/, "");
      const last = bare.split(".").pop();
      for (const needle of new Set([bare, last])) {
        if (sourceText.includes(needle) || manifests.includes(needle)) return false;
      }
      return true;
    });
    if (unknown.length) {
      apiFindings.push({
        rule: name,
        names: unknown,
        why:
          "ソースにも依存の宣言にも見つからない。テンプレートの既定がこのプロジェクトに" +
          "当てはまっていない可能性がある。実在しないと断定はできないので、1件ずつ確かめて、" +
          "不要なら規約から外す。",
      });
    }
  }

  return { applicable: true, pathsFindings, apiFindings };
}

function main(argv) {
  const pi = argv.indexOf("--project");
  const projectDir = pi >= 0 && argv[pi + 1] ? path.resolve(argv[pi + 1]) : process.cwd();
  const asJson = argv.includes("--json");
  const r = check(projectDir);

  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
    return r.pathsFindings.length + r.apiFindings.length > 0 ? 1 : 0;
  }
  if (!r.applicable) {
    console.log(`検査の対象外: ${r.reason}（${projectDir}）`);
    return 0;
  }
  if (!r.pathsFindings.length && !r.apiFindings.length) {
    console.log(`食い違いは見つかりませんでした（${projectDir}）`);
    return 0;
  }
  for (const f of r.pathsFindings) {
    console.log(`\n[NG] ${f.rule}: paths が1件も一致しない`);
    for (const g of f.globs) console.log(`       - ${g}`);
    console.log(`     -> ${f.why}`);
  }
  for (const f of r.apiFindings) {
    console.log(`\n[?] ${f.rule}: 名指しした識別子が見つからない`);
    for (const n of f.names) console.log(`       - ${n}`);
    console.log(`     -> ${f.why}`);
  }
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exit(main(process.argv.slice(2)));
}
