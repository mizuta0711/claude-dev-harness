## 環境: Unity

### 開発環境

| 項目 | 値 |
|------|----|
| Unity | <!-- TODO: バージョンを記入 --> |
| Namespace | `{{PROJECT_NAME}}` |
| レンダーパイプライン | <!-- TODO: URP / HDRP / Built-in --> |

### フォルダ構成

```
Assets/
├── Scenes/          # シーンファイル (.unity)
├── Scripts/
│   ├── Core/        # GameManager, SceneLoader など
│   ├── Player/      # PlayerController, PlayerInput など
│   ├── UI/          # HUD, MenuController など
│   └── Data/        # ScriptableObject 定義
├── Prefabs/
│   ├── Player/
│   └── UI/
├── Materials/
├── Animations/
└── Settings/        # レンダーパイプライン設定（変更しない）
```

<!-- TODO: 不要なサブフォルダを削除し、必要なものを追加する -->

### コーディング規約

C# の規約は [.claude/rules/csharp-unity.md](.claude/rules/csharp-unity.md) に置いてある
（`Assets/Scripts/**` を読んだ時点で自動ロードされるため、手動で読む必要はない）。

要点だけ再掲する:

- **ファイル名とクラス名を一致させる** / **namespace は `{{PROJECT_NAME}}`**
  — どちらもコミット前フック（`pre-commit-cs-check`）が検査する
- Unity の Play Mode 中は C# ファイルを編集しない
- `.meta` ファイルは手動で作成・削除しない（Unity が自動管理）

### コマンドとゲート

Unity にはコマンドラインのビルド・型チェック手段を既定では持たせていない
（`harness.config.json` の `commands` は全て `null`、`gates.preCommit` は空）。
そのため `/harness-core:build-check` は「この環境に CLI チェックは無い」と報告して終了する。

代わりに **`pre-commit-cs-check` フック**（クラス名一致・namespace 宣言の静的検査）と
**Unity MCP による確認**（下記）がその役割を担う。

### Unity MCP（Claude からの Editor 操作）

`.mcp.json` でプロジェクトスコープ登録済み。`mcp__UnityMCP__*` ツールで Unity Editor を直接操作できる。

- スクリプト変更・作成後は `read_console` でコンパイルエラー・警告の有無を確認してから完了報告する
- シーン構成の確認・変更は `manage_scene` / `manage_gameobject` / `find_gameobjects` を利用する
- ツールが見つからない場合は未接続。Unity Editor 側の状態
  （`Window > MCP For Unity` で Local Server が起動しているか）をユーザーに確認してもらう

一連の確認手順は `/harness-unity:unity-verify` スキルに定義してある。

> **重要**: `harness.config.json` の `verification.manualGate` は `true`。
> **「動作確認」＝面白さ・見た目・実プレイ感の確認は、依然としてユーザーが Unity Editor で行う。**
> MCP はコンパイル可否や状態確認を代行するものであり、**Play Mode での体感確認の代替にはならない**。

### 規模判定の環境固有ルール

- 新しい MonoBehaviour システムを追加する場合は **L 寄り**で提示する
- 複数シーン・複数 Prefab に影響する場合は **L**
- `/harness-core:design-review feature` は code-reviewer と **game-designer** を並列起動する
  （ゲームデザイン・難易度・プレイヤー体験の観点）

### 環境固有スキル

| スキル | 用途 |
|--------|------|
| `/harness-unity:unity-verify` | Unity MCP でシーン状態・Play モード・Console を確認し、動作確認計画と突き合わせて報告する |
