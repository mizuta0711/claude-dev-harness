# API一覧

## 概要

<!-- プロジェクトの API エンドポイント一覧 -->

**共通仕様:**
- 認証: NextAuth（認証不要エンドポイントを除き全て認証必須）
- リクエストバリデーション: Zod
- レスポンス形式: `{ success: boolean, data?: any, error?: { code: string, message: string, fields?: Record<string, string> } }`
- ページネーション: カーソルベース（`cursor`, `limit` パラメータ）

---

<!-- エンドポイントごとにリクエスト・レスポンスの JSON 例を必ず記載すること -->

---

## 改訂履歴

| 版数 | 日付 | コミット | 内容 | 担当 |
|------|------|---------|------|------|
| 1.0 | yyyy-mm-dd | | 初版作成 | |
