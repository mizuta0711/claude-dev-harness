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
 * **「この規約は一度もロードされない」と誤報告する**（実測: engineer-potal で出た）。
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
  out = out.split("**").join("\u0000").split("*").join("[^/]*").split("\u0000").join(".*");
  return new RegExp("^" + out + "$");
}

/** frontmatter の paths を読む */
export function parsePaths(markdown) {
  const m = /^---\n([\s\S]*?)\n---/.exec(String(markdown || "").replace(/\r\n/g, "\n"));
  if (!m) return [];
  const out = [];
  let inPaths = false;
  for (const line of m[1].split("\n")) {
    if (/^paths:\s*$/.test(line)) {
      inPaths = true;
      continue;
    }
    if (inPaths) {
      const item = /^\s*-\s*"?([^"]+?)"?\s*$/.exec(line);
      if (item) {
        out.push(item[1]);
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
export function extractIdentifiers(markdown) {
  const spans = [...String(markdown || "").matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  const found = new Set();
  for (const span of spans) {
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
  return [...found].sort();
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
