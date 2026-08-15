# アプリケーションアーキテクチャ設計

> このファイルは**骨格**である。`{{PROJECT_NAME}}` の実態に合わせて書き換えること。
> 書き方と役割分担は [README.md](./README.md) を参照。
>
> **Unity では本ファイル1本で足りることが多い。** 分割が必要になってから増やす。

## 全体構成（推奨・既定）

```
GameManager（シングルトン）
├── CoreSystem          # コアロジック
├── PlayerSystem        # プレイヤー操作・状態管理
├── UISystem            # HUD・メニュー管理
└── AudioSystem         # BGM・SE 管理
```

<!-- TODO: このゲームのシステム構成に書き換える。 -->

## レイヤー構造

```
UI Layer        HUD / メニュー / 各画面
   ↕ イベント
Game Layer      GameManager / 各 System
   ↕ 参照
Data Layer      ScriptableObject（パラメータ定義）
```

## 依存関係の原則

- **GameManager は各 System を保持する**（逆は禁止）
- **System 間の直接参照は禁止**（GameManager 経由またはイベントで通信）
- **ScriptableObject はどの System からも参照可能**（純粋なデータ）
- **UI Layer は Game Layer を参照できるが、逆は禁止**

<!-- TODO: 原則を変えた場合は理由を1行残す。 -->

## 本作固有の構造ルール

<!-- TODO: このゲーム特有の構造（ステージの持ち方・進行管理・セーブ単位など）を書く。 -->

## 当たり判定の方針

<!-- TODO: Collider / Trigger の使い分け、レイヤー設計、判定の責務をどこに置くかを書く。
     ここが曖昧だとバグの温床になるため、実装前に決める。 -->

## ScriptableObject 設計方針

| SO 名 | 用途 |
|-------|------|
| （例）PlayerSettingsSO | プレイヤーパラメータ |
| （例）GameSettingsSO | ゲーム全体設定 |

<!-- TODO: 実際の SO 一覧に書き換える。「何を SO にして何をコードに書くか」の基準も添える。 -->

## 命名規則

| 種別 | 命名パターン | 例 |
|------|------------|-----|
| MonoBehaviour | PascalCase | `PlayerController` / `GameManager` |
| ScriptableObject | PascalCase + SO | `PlayerSettingsSO` |
| Interface | 先頭に I | `IInteractable` / `IDamageable` |
| イベント | On + 動詞過去形 | `OnPlayerDied` / `OnStageCleared` |

## 着手前に合意が必要な設計判断

実装を始める前にユーザーと合意しておくべき事項を列挙する。

<!-- TODO: 例）操作方式（自動 / 手動）、リトライの単位、難易度の調整軸、
     セーブデータの互換性方針。決まったら「決定」と日付を添えて残す。 -->

## 改訂履歴

| 版数 | 日付 | 内容 | 担当 |
|------|------|------|------|
| 1.0 | yyyy-mm-dd | 初版作成（テンプレート適用） | |
