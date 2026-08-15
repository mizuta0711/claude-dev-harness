---
paths:
  - "{{CORE_PROJECT}}/**"
  - "{{UI_PROJECT}}/**"
---

# C# / .NET 8 実装のルール

<!-- 移設元: 旧 WPF テンプレート（アーカイブ済み）の CLAUDE.md「実装ルール（全般）」「コーディング規約」、
     03_library_docs/03_async_threading_guide.md、
     01_development_docs/09_動的コード実行のセキュリティ方針.md。
     パス条件付きルールにすることで、該当プロジェクトのファイルを読んだ時だけ自動ロードされる。 -->

## レイヤ分離（最重要）

- **`{{CORE_PROJECT}}` は WPF に依存してはいけない**（`System.Windows` 名前空間を使用しない）
- **UI Layer は Core Layer を参照できるが、逆は禁止**
- UI スレッドへのマーシャリングは ViewModel 側で行い、Core 層では行わない
- **例外は Core 層でキャッチせず、イベントで通知して ViewModel 側でハンドリングする**

## コーディング規約

- C# 12 の機能を積極的に使用する（Primary Constructor、Collection Expression 等）
- `record` は不変データ（Config 系）に使用する
- `nullable` を有効にし、`null` の取り扱いを明示する

## 非同期とスレッド

WPF ではバックグラウンドスレッドと UI スレッドの分離が品質の要になる。

1. **`async/await` ＋ `CancellationToken` を徹底する。** 同期ブロッキング（`.Result` / `.Wait()`）は禁止
   — UI スレッドでデッドロックする
2. **UI 要素・バインド中の `ObservableCollection` は UI スレッドからのみ操作する**
   （別スレッドから `Add` すると `NotSupportedException` やコレクション破損）
3. **マーシャリングは ViewModel の責務。** Core は `System.Windows` に依存しない
4. **Core のイベントはバックグラウンドスレッドから発火してよい**（UI 反映時に ViewModel が切り替える）
5. `async void` はイベントハンドラ以外で使わない（例外を捕捉できない）

### CancellationToken

- 公開 async メソッドは末尾に `CancellationToken ct = default` を取り、内部 await へ渡す
- **キャンセル例外（`OperationCanceledException`）は正常系として握りつぶす。** エラーログを出さない

### ConfigureAwait

判断基準は「**await の続きで UI / ObservableCollection を触るか**」:

| 場所 | 指定 |
|------|------|
| `{{CORE_PROJECT}}`（WPF 非依存） | **`ConfigureAwait(false)` を付ける**（UI スレッドへの不要な復帰とデッドロックを避ける） |
| ViewModel で await 後に UI を触る | 付けない（既定 true）、または明示的に Dispatcher で UI スレッドへ戻す |

### Dispatcher の使い分け

| API | 性質 | 用途 |
|-----|------|------|
| `Dispatcher.BeginInvoke(...)` | 非同期（投げて即戻る） | 高頻度更新など応答性優先（**推奨**） |
| `Dispatcher.Invoke(...)` | 同期（完了まで待つ・戻り値可） | 順序保証や結果が必要なとき |
| `Dispatcher.InvokeAsync(...)` | 非同期＋await 可 | await したいとき |

- 既に UI スレッド上か不明なら `if (dispatcher.CheckAccess()) { ... } else dispatcher.BeginInvoke(...)`
- 大量更新で UI が詰まる場合は、一時バッファに溜めて `DispatcherTimer`（50–100ms）でバッチ反映し、
  リストは仮想化（`VirtualizingStackPanel`）して表示上限を設ける

### 定期実行

定期処理は `System.Threading.PeriodicTimer` を使う（`DispatcherTimer` ではない ＝ UI スレッド不要）。
1回の失敗でサービスを止めず、`ErrorOccurred` 等で通知して継続する（処理の性質により中断もあり得る）。

### 起動・停止・破棄は冪等に

`StartAsync` / `StopAsync` / `DisposeAsync` は**二重呼び出しでも例外を出さない**こと。

```csharp
public async Task StopAsync()
{
    CancellationTokenSource? cts;
    lock (_gate) { cts = _cts; _cts = null; }   // 状態を先に奪う（二重実行を無害化）
    if (cts is null) return;                     // 既に停止済み → 何もしない
    cts.Cancel();
    cts.Dispose();
}
```

- ポイント: 「フィールドを null にしてから後始末」「null なら早期 return」「`OperationCanceledException` は無視」
- `Start` 系も再入時はまず `Stop` を呼んでから開始する
- アプリ終了時は `MainWindow.OnClosing` で各サービスの `StopAsync` と `CancellationTokenSource.Cancel()` を呼ぶ。
  リソースを抱えるサービスは `IAsyncDisposable` を実装する

## 外部入力の扱い

ファイル・ネットワーク・ユーザー入力など外部由来のデータは信頼できないものとして扱う。
パース時のバリデーション、サイズ/長さの上限、例外処理を必ず入れる（constitution.md セキュリティ原則）。

## 動的コード実行・プラグインを扱う場合

> スクリプト実行・プラグイン・DLL ロード・リフレクション等で**任意コードを実行する設計を採る場合のみ**適用する。
> 該当機能が無ければ読み飛ばしてよい。

前提: 言語処理系（Roslyn 等）単体では完全な実行サンドボックスは実現できない。したがって
「悪意あるコードからの防御」ではなく「**ローカル開発者が自分で書いたコードを自分の PC で実行する**」
という信頼前提を明示し、**事故防止のガードレール**を設計する。

1. **既定無効・明示オプトイン。** 有効化の粒度はプロジェクト単位（アプリ全体で一括有効化しない）
2. **トラストを成果物に保存しない。** プロジェクトファイル自体ではなく、ローカルのアプリ設定へ
   **プロジェクトの絶対パスをキー**として永続化する。
   （プロジェクトファイルに持たせると、配布先が気づかずに任意コードを実行してしまう）。
   パスが変わった場合は未トラストへ戻す
3. **有効化の導線**: 未トラストならインフォバナーで明示 → ワンクリック有効化 + **確認ダイアログを1枚挟む**。
   一度有効化した自作プロジェクトは次回以降バナーを出さない。解除は設定画面から
4. **参照・名前空間を限定する。** 安全な既定セット（`System` / `System.Linq` / `System.Text` /
   `System.Collections.Generic` 相当）に絞り、ファイル I/O・ネットワーク・プロセス起動は既定で未参照
5. **実行時ガード（必須）**: ①タイムアウト + `CancellationToken` を必ず渡す ②例外は呼び出し元で捕捉し、
   ログ通知のうえ当該処理をスキップして**アプリは継続**する ③出力にサイズ上限を設け OOM を防ぐ
6. **DLL・プラグイン**: 明示フォルダのみ走査し**自動実行しない**。読込済み一覧を可視化する。
   可能なら `AssemblyLoadContext` で隔離する。プラグインは実質フルトラストである旨を明記する
7. **利用者への明記（必須）**: 「これは事故防止の既定であり、悪意あるコードからの防御ではない」ことを
   マニュアル・設定画面に書く。完全なサンドボックス・プロセス分離は対象外である旨を設計書に明記する

**該当機能の機能設計書（`docs/features/`）に、上記のどの項目をどう満たすかを明記すること。**

## 参照

- サービスの実態: [docs/設計書/サービス一覧.md](../../docs/設計書/サービス一覧.md)
- レイヤ間の対応: [docs/設計書/View-ViewModel-Service対応表.md](../../docs/設計書/View-ViewModel-Service対応表.md)

<!-- TODO: このアプリ固有の実装ルール（中核ドメインの不変条件・状態遷移・各サービスの責務など）を
     追記する。ここに置くのは「実装時に毎回思い出す必要がある短い注意点」のみ（目安5〜6項目まで）。
     まとまった設計方針は .claude/01_development_docs/ へ。 -->
