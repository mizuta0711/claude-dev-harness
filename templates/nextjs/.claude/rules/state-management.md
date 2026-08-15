---
paths:
  - "src/features/**/stores/**"
  - "src/stores/**"
  - "src/lib/stores/**"
---

# 状態管理（Zustand）のルール

<!-- 移設元: 旧 Next.js テンプレート（アーカイブ済み）の 03_library_docs/02_state_management_guide.md の
     環境依存・プロジェクト非依存な部分。
     ストアの一覧・個別の状態定義（③）はここに書かない → docs/設計書/ と .claude/01_development_docs/ へ。 -->

## 設計原則

1. **機能別分離** — 機能ドメインごとに独立したストアを作る（巨大な単一ストアにしない）
2. **不変性を保つ** — 配列・オブジェクトは常に新しい参照を作る（スプレッド演算子等）
3. **`any` 型は禁止**
4. 永続化が必要なストアのみ `persist` ミドルウェアを使う

```typescript
export const useExampleStore = create<ExampleState>()(
  persist(
    (set, get) => ({
      items: [],
      addItem: (item) => set((state) => ({ items: [...state.items, item] })),
      removeItem: (id) => set((state) => ({
        items: state.items.filter((item) => item.id !== id),
      })),
    }),
    { name: 'example-store' }
  )
);
```

## ストアに入れるもの / 入れないもの

ストアの役割は **API データのキャッシュ**と、**画面をまたいで保持が必要な状態**に限定する。

| 入れる（ストア） | 入れない（`useState`） |
|---|---|
| API から取得したエンティティデータ（複数コンポーネントから参照される） | UI の一時状態（モーダル開閉・フォーム入力値・アコーディオン） |
| セッション状態（画面遷移をまたいで保持が必要） | 個別 API のローディング状態（各フックで管理） |
| 永続化が必要なデータ（ユーザー設定等） | エラー状態（各フックで管理） |
| | 派生データ（グルーピング結果等。都度計算する） |

**判断基準**（上から順に見る）:

1. 2つ以上のコンポーネントから参照されるか → Yes ならストア
2. 画面遷移後も保持が必要か → Yes ならストア
3. どちらも No → `useState` で十分

> 例外: 複数コンポーネントから参照される UI ステート（送信中フラグ等）はストアに入れてよい。

## 永続化（persist）の判断

**API から再取得できるデータは永続化しない。** 永続化するのは「再訪問時に復元したい」ものだけ。

- DB に保存済みでセッション切替時にリセットされるデータは `persist` 不要
- 永続化するストアは `name`（localStorage キー）を明示する

## パフォーマンス

**セレクターで必要な値だけを取る。** ストア全体を取得すると無関係な更新で再レンダリングされる。

```typescript
// 推奨
const petName = usePetStore((state) => state.name);

// 非推奨（ストア全体）
const petStore = usePetStore();
```

## ハイドレーション

`persist` で localStorage から復元される値は、**SSR 時には存在しない**ため初期値との差異でハイドレーション不一致が起きる。

- 復元値を参照する処理は `useEffect` 内に置く
- ハイドレーション完了後に UI を切り替える

<!-- TODO: このアプリのストア構成（どのストアが何を持つか）は docs/設計書/ 側に書く。
     ここに追記するのは「新しくストアを作るときに毎回守る規約」だけ。 -->
