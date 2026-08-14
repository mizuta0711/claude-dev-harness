---
paths:
  - "Assets/Scripts/**"
---

# Unity C# 実装のルール

<!-- 移設元: Unity テンプレートの CLAUDE.md「コーディング規約」「作業ルール」および
     .claude/01_development_docs/01_app_architecture.md（依存関係の原則・命名規則）。
     パス条件付きルールにすることで、Assets/Scripts/ を読んだ時だけ自動ロードされる。 -->

## コーディング規約

- スクリプトは `Assets/Scripts/` 以下の適切なサブフォルダに配置する
- **MonoBehaviour を継承するクラスはファイル名とクラス名を必ず一致させる**
  （`harness-unity` の `pre-commit-cs-check` フックがコミット前に検査する）
- **namespace は `{{PROJECT_NAME}}`** を宣言する
  （フックは `.claude/harness.config.json` の `envOptions.rootNamespace` を見て検査する）
- ScriptableObject でゲームパラメータを外出しする（マジックナンバー禁止）
- `using UnityEngine;` は必須、不要な using は削除する
- Unity の最新 API を使用する（`FindObjectOfType` より `FindFirstObjectByType` など）

## 命名規則

| 種別 | 命名パターン | 例 |
|------|------------|-----|
| MonoBehaviour | PascalCase | `PlayerController`, `GameManager` |
| ScriptableObject | PascalCase + SO | `PlayerSettingsSO` |
| Interface | 先頭に I | `IInteractable`, `IDamageable` |
| イベント | On + 動詞過去形 | `OnPlayerDied`, `OnStageCleared` |

## 依存関係の原則

- **GameManager は各 System を保持する**（逆は禁止）
- **System 間の直接参照は禁止**（GameManager 経由またはイベントで通信）
- **ScriptableObject はどの System からも参照可能**（純粋なデータ）
- **UI Layer は Game Layer を参照できるが、逆は禁止**

<!-- TODO: 実際のシステム構成・レイヤー構造をプロジェクトに合わせて記入する。
     実態（クラス・シーン・プレハブの一覧）は docs/設計書/ に書く — 二重管理の禁止。 -->

## 作業ルール

- スクリプト生成後は必ずファイルパスを明示する（例: `Assets/Scripts/Player/PlayerController.cs`）
- 既存ファイルを変更する前に内容を確認する
- **Unity の Play Mode 中は C# ファイルを編集しない**
- `.meta` ファイルは手動で作成・削除しない（Unity が自動管理）
- `Assets/Settings/` は変更しない（URP 設定）
