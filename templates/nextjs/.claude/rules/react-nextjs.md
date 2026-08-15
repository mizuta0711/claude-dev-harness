---
paths:
  - "src/features/**/*.tsx"
  - "src/components/**/*.tsx"
  - "src/app/**/*.tsx"
---

# React / Next.js コンポーネントのルール

## コンポーネント実装

- `memo<Props>` パターン + `displayName` 設定
- `useCallback` / `useMemo` で不要な再レンダリングを防止
- Server / Client Components を適切に分離

## UI 実装

- 縦スクロール対応（`overflow-y-auto`、`max-h-*` 等）
- `min-h-screen` / `h-full` 等の適切な高さ設定
- **レスポンシブデザイン（モバイル・デスクトップ両対応）。確認幅の既定は スマホ 375px / PC 1280px**
- **インラインの `style={{ width }}` は画面幅を超えていないか確認する**
  （固定 px 幅はスマホで横スクロールを発生させる。Tailwind のレスポンシブ指定を優先する）

## ストアの利用

**ストアライブラリ（Zustand 等）を使っている場合のみ**適用する。使っていなければこの節は読み飛ばす。

- **セレクターで必要な値だけを取る**（`useStore((s) => s.name)`）。ストア全体を取ると無関係な更新で再レンダリングされる
- UI の一時状態（モーダル開閉・入力値）はストアに入れず `useState` を使う
- ストア設計の詳細な規約は `state-management.md` にある（ストアを使わないプロジェクトでは配置されていない）

## 参照

- Next.js 16 の破壊的変更: `node_modules/next/dist/docs/` を確認すること
- 画面ごとの動作確認: `/harness-nextjs:browser-test`

<!-- TODO: このアプリ固有の画面レイアウト規約（共通ヘッダの構造・必須のコンテナ等）があれば追記する。
     まとまったデザイン方針は .claude/02_design_system/ へ。 -->
