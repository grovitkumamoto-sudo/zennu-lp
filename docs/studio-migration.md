# STUDIOから新サイトへの移行メモ

## 公開URL

DNS切り替え後も次のURLを変更しません。

- `/`
- `/blog/`
- `/terms/`
- `/corporate-terms/`
- `/privacy/`
- `/law/`
- `/sitemap.xml`
- `/robots.txt`

法務ページの初回公開版は `2026.1`、施行日は `2026-08-05` です。

## microCMS

サービスIDは `zennuwellness` です。Vercelには、microCMSの読み取り専用APIキーを環境変数 `MICROCMS_API_KEY` として登録します。

APIキーが未設定の場合やmicroCMSの取得に失敗した場合も、リポジトリ内の確定済み本文を使ってビルドできます。

### ブログAPI

APIエンドポイント：`blogs`  
形式：リスト

| フィールドID | 種類 | 必須 |
|---|---|---|
| `title` | テキスト | 必須 |
| `slug` | テキスト | 必須 |
| `eyecatch` | 画像 | 任意 |
| `category` | テキスト | 任意 |
| `excerpt` | テキストエリア | 任意 |
| `body` | リッチエディタ | 必須 |
| `publishedAt` | 日時 | 必須 |
| `noindex` | 真偽値 | 必須 |

記事の公開URLは `/blog/{slug}/` です。公開後はmicroCMS WebhookからVercelのDeploy Hookを呼び出し、サイトを再生成します。

### 法務文書API

APIエンドポイント：`legal-versions`  
形式：リスト

| フィールドID | 種類 | 必須 |
|---|---|---|
| `documentType` | セレクト | 必須 |
| `title` | テキスト | 必須 |
| `slug` | テキスト | 必須 |
| `version` | テキスト | 必須 |
| `effectiveDate` | 日時 | 必須 |
| `body` | リッチエディタ | 必須 |
| `changeSummary` | リッチエディタ | 必須 |
| `seoTitle` | テキスト | 必須 |
| `seoDescription` | テキストエリア | 必須 |
| `requiresConsent` | 真偽値 | 必須 |
| `reviewedBy` | テキスト | 任意 |
| `isCurrent` | 真偽値 | 必須 |
| `archiveFile` | ファイルまたはURL | 任意 |

`documentType` の選択肢：

- `terms`
- `corporateTerms`
- `privacy`
- `law`

同じ文書種別で `isCurrent = true` にするコンテンツは1件だけにします。旧版は削除せず、`isCurrent = false` として会社の記録に残します。

## DNS切り替え前

1. Vercel Previewで全ページを確認する。
2. トップ、ブログ、法務4ページがすべて `200 OK` になることを確認する。
3. title、description、canonical、OGP、構造化データを確認する。
4. Hacomono、LINE、電話、Googleマップのリンクを実機で確認する。
5. GTM Preview、GA4 DebugView、Meta Test Eventsで計測を確認する。
6. STUDIOの現行ページをPDFまたはHTMLで非公開保存する。
7. DNSのTTLを確認し、新サイトへ切り替える。

## DNS切り替え後

1. `https://zennuwellnessdesign.jp/` と法務4ページを再確認する。
2. Search Consoleでサイトマップを再送信する。
3. 主要ページのインデックス登録状況と404を確認する。
4. GA4、Meta、Hacomonoへの遷移を確認する。
5. 1〜2週間安定稼働を確認してからSTUDIOを解約する。
