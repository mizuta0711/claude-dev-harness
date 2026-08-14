# templates/（Phase 2 で作成）

プラグインでは配布できないもの（CLAUDE.md / `.claude/rules/` / `docs/` 骨格 /
`.claude/settings.json` / `.claude/harness.config.json` / `.gitignore` / `.mcp.json`）を
**プロジェクト生成時にコピーする層**。

予定する構成:

```
templates/
├── base/     # 全環境共通（CLAUDE.md 共通部 / docs 骨格 / config 雛形 / settings.json 雛形）
├── nextjs/   # 環境差分
├── unity/
└── wpf/
```

現時点では空。Phase 2 で作成する。

`settings.json` 雛形に入れる permissions の方針は
[../docs/permissions-baseline.md](../docs/permissions-baseline.md) に先行して記録してある。
