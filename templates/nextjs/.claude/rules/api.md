---
paths:
  - "src/app/api/**"
  - "src/features/**/hooks/**"
  - "src/lib/services/**"
---

# API 実装のルール

## API Route

- `NextRequest` / `NextResponse` パターン
- try/catch でエラーハンドリング、適切な HTTP ステータスコード
- 直接 DB 操作禁止 — 必ず Service 層を経由

## API 型契約の必須化

BE/FE を別サブエージェントに委譲する場合、必ず共有型定義を先に作成してから委譲する。

- API ルート実装前に `src/types/` に共有レスポンス型を定義する
- バックエンド（route.ts）とフロントエンド（hooks）の両方がその型を import する
- レビュー時に API 提供側と消費側の型突き合わせを必須とする

> このルールは BE 側だけでは成立しない。そのため本ファイルは `src/app/api/**` だけでなく
> `src/features/**/hooks/**`（消費側）と `src/lib/services/**`（Service 層）でもロードされる。

## 入力バリデーション

- API 設計時に入力バリデーション仕様（Zod 等）を機能設計書に明記する
- raw SQL を使う場合は必ずパラメータバインドを使う

## 参照

- 個別エンドポイントの定義（実態）: [docs/設計書/API一覧.md](../../docs/設計書/API一覧.md)
- レイヤ間の対応: [docs/設計書/API・サービス・リポジトリ・フック対応表.md](../../docs/設計書/API・サービス・リポジトリ・フック対応表.md)

<!-- TODO: 命名規則・ページネーション方式・エラーレスポンス形式をプロジェクトで定めたらここに追記する
     （個別エンドポイントの定義は docs/設計書/API一覧.md にのみ書く — 二重管理の禁止） -->
