# GroVitニュース記事 自動下書き生成タスク用リファレンス

このファイルは週次のGroVitニュース記事自動生成タスクが毎回参照する。ここを編集すればタスクの中身を調整できる。
ZenNu WELLNESS DESIGNのブログ自動生成（`docs/blog-automation-brief.md`）と対になる、別会社・別サイト向けの設定ファイル。

## サイト基本情報

- microCMSサービスID: `zennuwellness`（ZenNuと同じmicroCMSサービス内の別エンドポイント）
- ニュースAPIエンドポイント: `https://zennuwellness.microcms.io/api/v1/grovit-news`
- 書き込み用APIキー: `~/.zennu-lp-secrets/microcms-write-key.txt`（ZenNuブログと共通のキーを使う）
- サイト本番URL: `https://grovit.jp`（プロジェクト実体は `/Users/moritakeaki/Documents/New project/grovit-corporate`、OpenAI Sites/Vercelでホスティング）
- コンテンツ表示先: トップページ「NEWS & JOURNAL」セクションと `/news` 一覧（`grovit-corporate/lib/microcms.ts` の `getNewsArticles`）

## ブランドファクト（記事内で使ってよい正確な情報。これ以外を断定的に書かない）

- 会社名: 株式会社GroVit（GroVit）
- 所在地: 熊本県熊本市中央区上通町6-15 2F（ZenNu WELLNESS DESIGNと同一住所）
- 電話: 096-277-7700
- 会社紹介文: 「パーソナルジム運営とWEBマーケティングを通して、人と事業のより良い変化をデザインする会社です。」
- ミッション: 日常にFITNESSを、毎日にHAPPINESSを。
- ビジョン: カラダを動かす場所から、人生が動く居場所へ。
- バリュー: 胸を張れるカラダを。胸を張れる仕事を。
- 事業1（PROJECT 001）: ZenNu WELLNESS DESIGN — 熊本市中央区上通でパーソナル指導とセルフ利用を組み合わせたハイブリッド型ジムを運営（詳細はZenNu側のブランドファクトを参照可）
- 事業2（BUSINESS 02）: WEBマーケティング事業 — LP制作・広告運用・クリエイティブ制作を通して、事業の価値が必要な人へ届く仕組みをつくる
- スタンス: 「トレーナーが営業マンではなく、カラダを変えるプロでいられること。お客様の不安ではなく、信頼から選ばれる仕事をします。」誇張した売り込み型の表現はしない

## コンテンツの狙い

GroVitは「自社でジムを運営しながら、そのWEBマーケティングも自社で行っている」という他にない立ち位置。記事はこの二つの視点を行き来しながら書く:

1. **フィットネス経営の視点**: 実店舗（ZenNu）運営で得た知見（会員継続・接客・店舗オペレーション等）
2. **WEBマーケティングの視点**: 実際にZenNuの集客で使っている手法（LP改善・広告運用・SEO・MEO等）を、他の事業者にも役立つ形で一般化して紹介

理論だけでなく「実際に自社で運用している」という裏付けが最大の差別化ポイントなので、抽象論に終始せず、可能な範囲で実体験に基づくトーンで書く（ただしZenNuの内部の実数値・非公開情報は書かない）。

## トピック候補（上から順に、まだ書いていないものを1つ選ぶ）

ZenNuを実例として自然に取り上げやすい（＝被リンクを自然に埋め込みやすい）トピックを優先する。

1. パーソナルジムのようなリアル店舗が自社でWEBマーケティングをやる意味（ZenNuが実例）
2. 店舗ビジネスの「続けやすさ」を設計するという考え方（ZenNuの運営哲学・料金プラン設計から）
3. LP(ランディングページ)改善で問い合わせ数を増やすために最初に見るべき指標（ZenNuでの取り組みを例に）
4. 店舗の口コミ・評判とWeb集客の関係（ZenNuの実績・お客様の声ページを例に）
5. 熊本のような地方都市でのWeb集客とMEO(Googleビジネスプロフィール)の重要性（ZenNuのアクセス・立地を例に）
6. 広告運用とオーガニック集客(SEO・ブログ)、両方をやるべき理由（ZenNuブログの取り組みを例に）
7. 問い合わせから成約までのファネルをどう可視化するか
8. 小規模事業者がクリエイティブ制作を外注 vs 内製する際の判断基準
9. 採用(リクルート)ページも実は集客導線になるという話
10. フランチャイズ展開を見据えた事業のブランド設計

<!-- ここにSEOレポート等に基づく優先順位変更のメモを追記していく（ZenNu側と同じ運用） -->

## 執筆ルール

- 文字数: 1500〜2500字程度
- 構成: H2見出し3〜4個、必要に応じてH3。導入文で読者の課題に触れ、結論を先出しする
- 敬体（です・ます調）、一人称は「GroVit」または「私たち」
- ブランドファクトに基づく正確な情報のみ記載し、実店舗(ZenNu)の非公開の数値・個人情報は書かない
- 誇張・断定的な効果表現（「必ず成果が出る」等）は使わない
- 記事末尾に問い合わせページへの内部リンクを設置: `<a href="https://grovit.jp/contact">お問い合わせはこちら</a>`
- **このニュースの主目的の一つはZenNu WELLNESS DESIGNサイトへの被リンク獲得。原則すべての記事で、本文中に自然な文脈でZenNuサイトへのリンクを1つ以上入れる**（「弊社が運営するZenNu WELLNESS DESIGNの事例では〜」のように、実例として触れる形が自然）
- リンク先はトップページに固定せず、記事の話題に応じて具体的なページに分散させる（同じURL・同じアンカーテキストの繰り返しは避ける）:
  - 料金・プランの話題 → `https://zennuwellnessdesign.jp/price/`（例:「ZenNuの料金ページ」）
  - 実績・お客様の声の話題 → `https://zennuwellnessdesign.jp/results/`（例:「ZenNuの実績・お客様の声」）
  - サービス内容・セルフ利用の話題 → `https://zennuwellnessdesign.jp/service/`
  - トレーナー・接客の話題 → `https://zennuwellnessdesign.jp/trainers/`
  - 店舗・立地・アクセスの話題 → `https://zennuwellnessdesign.jp/facility/` または `https://zennuwellnessdesign.jp/access/`
  - ブログ記事の話題(口コミの見方・初めての方向け等)と関連する場合 → `https://zennuwellnessdesign.jp/blog/` 配下の該当記事へ直接リンク（`GET https://zennuwellness.microcms.io/api/v1/blogs?limit=100&fields=title,slug` で一覧を取得し、話題に近いものを選ぶ）
  - どれにも当てはまらない場合のみトップページ(`https://zennuwellnessdesign.jp/`)
- アンカーテキストは「こちら」のような曖昧な表現ではなく、リンク先の内容が分かる具体的な文言にする
- bodyはリッチエディタ用の簡易HTML（`<h2>` `<h3>` `<p>` `<ul><li>` `<a>` のみ使用）

## microCMSフィールド

grovit-newsのフィールドはZenNuのblogsと似ているが**slugフィールドが無い**（コンテンツIDは指定可能・自動生成でも可）。

| フィールドID | 内容 |
|---|---|
| title | 記事タイトル |
| category | カテゴリ（自由入力。例: 「Webマーケティング」「フィットネス経営」「お知らせ」） |
| body | 本文HTML |
| noindex | false固定 |
| eyecatch | 指定しない（未設定でよい） |

## 下書き作成手順（技術メモ）

1. `GET https://zennuwellness.microcms.io/api/v1/grovit-news?limit=100&fields=title,category` （ヘッダー `X-MICROCMS-API-KEY: <キー>`、キーは`~/.zennu-lp-secrets/microcms-write-key.txt`）で既存記事一覧を取得し、重複トピックを避ける
2. コンテンツID用に半角英数字の文字列を生成する（例: `web-marketing-for-local-store`）。slugフィールドは無いが、コンテンツIDとしてそのまま使う
3. 以下の形のJSONを一時ファイル（例: `/tmp/grovit-news-entry.json`）に書き出す:
   ```json
   { "endpoint": "grovit-news", "id": "生成したID", "title": "...", "category": "...", "body": "...", "noindex": false }
   ```
4. `cd /Users/moritakeaki/Downloads/ClaudeCode && node scripts/blog-draft-put.mjs /tmp/grovit-news-entry.json` を実行して下書き保存する（生のcurlコマンドではなく、必ずこのスクリプト経由で保存すること。許可リストに登録済みのため無人実行でも確認なしで完了する）
5. コマンドの標準出力で保存成功（下書き保存に成功しました）を確認する。失敗した場合はエラー内容をそのまま報告し、絶対に黙って諦めない・絶対に公開状態にはしない
6. 記事は必ず「下書き」のまま終える（`blog-draft-put.mjs`は常に`?status=draft`で保存する）
