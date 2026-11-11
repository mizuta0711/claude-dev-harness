# {{APP_NAME}} 配布サイトの公開手順

配布サイト {{SITE_URL}} を、VPS（Ubuntu + Nginx）で公開・更新する手順です。
**公開は、利用者が指示したときだけ行います。** この手順書があること自体は、公開を意味しません。

## 構成

| 項目 | 値 |
|---|---|
| サーバー | Ubuntu + Nginx |
| リポジトリ | `{{GITHUB_REPO}}`（private なら、サーバで gh CLI か SSH の認証が要る） |
| Web ルート | `{{SERVER_REPO_DIR}}/web` |
| デプロイ方式 | `git pull` がそのままデプロイ（Nginx がリポジトリ内の `web/` を直接配信する） |
| インストーラーの置き場 | `web/downloads/`（Git 管理外。`.exe` はリポジトリに入れない） |
| Nginx 設定の雛形 | `web/deploy/site.nginx.conf` |

## 初回セットアップ

```console
# 1. リポジトリを clone する（SSH または gh の認証済みの状態で）
sudo -u {{SERVER_USER}} git clone git@github.com:{{GITHUB_REPO}}.git {{SERVER_REPO_DIR}}

# 2. Nginx の設定を置く（root を web/ に向ける）
sudo cp {{SERVER_REPO_DIR}}/web/deploy/site.nginx.conf /etc/nginx/sites-available/{{SITE_SLUG}}
sudo ln -s /etc/nginx/sites-available/{{SITE_SLUG}} /etc/nginx/sites-enabled/{{SITE_SLUG}}
sudo nginx -t && sudo systemctl reload nginx

# 3. HTTPS の証明書を取得する（Let's Encrypt）
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d {{SITE_HOST}}
```

`{{SITE_HOST}}` の DNS（A レコード）が、VPS の IP アドレスを指していることを先に確かめます。certbot が 443 番と証明書の設定を自動で追記し、80 番は 443 番へリダイレクトされます。

## 新しい版を公開する

```console
cd {{SERVER_REPO_DIR}}

# 1. サイト全体（HTML・CSS・JS・downloads.json）を更新する
sudo -u {{SERVER_USER}} git pull --rebase

# 2. インストーラーを GitHub の Release から取得する（ランタイムあり・なしの両方）
sudo -u {{SERVER_USER}} gh release download v{版} --dir web/downloads --clobber

# 3. downloads.json の sha256 と一致するか照合する
sha256sum web/downloads/{{APP_NAME}}-{版}-win-x64-*.exe

# 4. 公開 URL で確かめる
curl -s {{SITE_URL}}downloads.json | grep '"latest"'
```

手順 4 で `"latest": "{版}"` が返れば成功です。静的ファイルの直接配信なので、Nginx の再起動は要りません。

**手順 1 と 2 の順を守ります。** 先に `downloads.json` だけが新しくなると、ダウンロードのボタンがまだ無いファイルを指します。

## 公開の前に確かめること

開発機で、版番号とファイル名の食い違い、リンク切れ、外部読み込みを検査します。

```console
node tools/check-web.mjs
node tools/check-web.mjs --dist dist     # インストーラーを作った後。大きさと SHA-256 も照合する
```

指摘が 0 件で、`web/downloads.json` の `latest` と `{{UI_CSPROJ}}` の `Version` が一致していることを確かめてから、Release を作ります。
`--dist` を付けると、書き換える前の例文（`<!-- 雛形: -->` の印）が残っていることも指摘になります。

## 設定を変えるとき

Nginx の設定そのものを変えたいときは、サーバの実ファイルを直接編集して再読み込みします。

```console
sudo nano /etc/nginx/sites-available/{{SITE_SLUG}}
sudo nginx -t && sudo systemctl reload nginx
```

雛形（`web/deploy/site.nginx.conf`）を変えたときは、実ファイルにも同じ変更を反映します。
