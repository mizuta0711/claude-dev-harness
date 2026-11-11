# web/downloads

配布サイトが配るインストーラー（`.exe`）を置く場所です。

- `{{APP_NAME}}-{版}-win-x64-setup.exe`（ランタイムあり）
- `{{APP_NAME}}-{版}-win-x64-noruntime-setup.exe`（ランタイムなし）

`.exe` はリポジトリに入れません（`.gitignore` で `web/downloads/*.exe` を除外しています）。サーバでは、GitHub の Release から次のコマンドで取得します。

```console
gh release download v{版} --dir web/downloads --clobber
```

ファイル名と大きさ、SHA-256 は `web/downloads.json` に記録します（インストーラーの作成スクリプトが書きます）。版番号の食い違いは `node tools/check-web.mjs` で検査します。
