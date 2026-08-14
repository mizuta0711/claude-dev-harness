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
- レスポンシブデザイン（モバイル・デスクトップ両対応）

## 参照

- Next.js 16 の破壊的変更: `node_modules/next/dist/docs/` を確認すること
- 画面ごとの動作確認: `/harness-nextjs:browser-test`
