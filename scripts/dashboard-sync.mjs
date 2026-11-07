// PostHog(LPのアクセス)とLINE Harness(友だち追加)のデータを「ZenNu 集客ダッシュボード」スプレッドシートに書き込むスクリプト。
// 毎日のスケジュールタスクから実行する想定。
//
// 前提:
//   - PostHog Personal API Key が ~/.zennu-lp-secrets/posthog-personal-api-key.txt にある
//   - LINE Harness の API_KEY が ~/.zennu-lp-secrets/line-harness-api-key.txt にある
//   - scripts/seo-config.json に posthogProjectId / lineHarnessUrl / dashboardSheetId を設定済み
//   - Google OAuthトークンに spreadsheets スコープが入っている
//     (入っていなければ `node scripts/oauth-authorize.mjs` をもう一度実行)
//
// 書き込み先:
//   データ_アクセス … 日付×LP×UTM単位の訪問数・FV離脱・hacomono遷移・LINEクリック。
//                     指定期間のPostHog行だけ入れ替える(手入力行やそれ以外の期間は残す)
//   データ_セクション … 日付×LP×セクション単位の到達セッション数(LPの funnel-tracking.njk が送る lp_section_view)。
//                     指定期間の行だけ入れ替える
//   データ_スクロール … 日付×LP単位で、ページを25/50/75%・最後までスクロールしたセッション数(PostHogの$pageleave)。
//                     セクション計測(2026-10-06〜)より前の期間も比べられるよう、PostHogの記録がある2026-08-04から入れてある
//   データ_LP流入元 … 日付×入口LP×流入元(Meta広告/MEO/AI検索/SEO/SNS投稿/直接/チラシ・店頭/その他)単位で、
//                     FV離脱・スクロール到達・hacomono遷移・LINEクリック・ウィジェット到達/操作/予約完了のセッション数。
//                     予約完了は、hacomonoのウィジェットがLPに送る通知(funnel-tracking.njk、2026-10-10〜)。
//                     最後の列に入口のutm_campaignを持つ(同じLPに複数のMetaキャンペーンを流すときに分けて数えるため)
//                     「LP×流入元」シートが期間を指定して集計する。2026-08-04から入れてある
//   データ_広告配信面 … Meta広告から来た人の、日付×LP×キャンペーン×配信面(utm_term={{placement}}、なければ参照元)ごとの
//                     FV離脱・料金到達・ウィジェット到達/操作/予約完了。「配信面分析」シートが データ_Meta配信面 と突き合わせる
//   データ_LINE追加 … LINE Harnessの友だち全件で毎回作り直す(ブロック・予約状況を最新化するため)
//   データ_CV … GA4のCVイベント(hacomono通常の complete_registration / hacomonoウィジェットの reserve_complete / BOOKOMの reservation_complete)を、
//                 経路マスタの条件(LP+UTM)で経路IDに割り当てて入れる。指定期間のGA4行だけ入れ替え、手入力行は残す
//
// 実行:
//   node scripts/dashboard-sync.mjs              直近3日分を同期(当日分は途中経過)
//   node scripts/dashboard-sync.mjs --days 30    過去30日分を入れ直す
//   node scripts/dashboard-sync.mjs --dry-run    スプレッドシートに書かず、取得結果だけ表示
//   node scripts/dashboard-sync.mjs --scroll-since 2026-08-04
//                                                データ_スクロールとデータ_LP流入元だけを指定日から入れ直す
//                                                (PostHogだけが元のシート。GA4のCVなど他のシートには触らない)

import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = path.join(os.homedir(), ".zennu-lp-secrets");
const CONFIG_PATH = path.join(__dirname, "seo-config.json");
const POSTHOG_HOST = "https://us.posthog.com";
const SITE_HOST = "zennuwellnessdesign.jp";
const TZ = "Asia/Tokyo";

const SHEET_ACCESS = "データ_アクセス";
const SHEET_LINE = "データ_LINE追加";
const SHEET_SECTION = "データ_セクション";
const SHEET_SCROLL = "データ_スクロール";
const SHEET_LP_SOURCE = "データ_LP流入元";
const SHEET_MASTER = "経路マスタ";
const SHEET_CV = "データ_CV";
const SHEET_PLACEMENT = "データ_広告配信面";
// GA4のCVイベント → CV種別・メモ。since より前は本番公開前のテスト予約が混ざるため取り込まない
const CV_EVENTS = {
  complete_registration: { label: "hacomono", since: "" },
  // hacomonoのウィジェット内での体験予約。予約APIが成功した直後に hacomono が choice_reserve_trial を送る
  reserve_complete: { label: "hacomonoウィジェット", since: "" },
  reservation_complete: { label: "BOOKOM", since: "2026-10-04" },
};

// LINE Harnessのタグ名(hacomono webhookで付与される)
const TAG_BOOKED = "予約_完了";
const TAG_MEMBER = "入会済み";

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const DAYS = Number(args[args.indexOf("--days") + 1]) || 3;
const SCROLL_SINCE = args.includes("--scroll-since") ? args[args.indexOf("--scroll-since") + 1] : "";

function readSecret(name) {
  const p = path.join(SECRETS_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`シークレットが見つかりません: ${p}`);
  return fs.readFileSync(p, "utf-8").trim();
}

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  for (const key of ["posthogProjectId", "lineHarnessUrl", ...(DRY_RUN ? [] : ["dashboardSheetId"])]) {
    if (!config[key]) throw new Error(`scripts/seo-config.json に ${key} が設定されていません`);
  }
  return config;
}

// "/wg1lp" と "/wg1lp/" を同じLPとして扱う
function normalizePath(p) {
  if (!p) return "";
  return p.endsWith("/") ? p : `${p}/`;
}

// 広告経由のutmはURLエンコードされたまま届くことがある
function decode(v) {
  if (!v) return "";
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function toDateString(d) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d);
}

// ---------------- PostHog ----------------

// Metaの広告審査などの自動アクセス。広告の公開直後に、Metaのデータセンター(米国・アイルランド・スウェーデン)から
// 幅1050px×高さ1837/1893pxの画面で一斉に来る。人の訪問ではないので、すべての集計から除く
const META_DC_CITIES = ["Prineville", "Forest City", "Altoona", "Clonee", "Luleå", "Lulea", "Fort Worth", "Gallatin",
  "Papillion", "Los Lunas", "Boardman", "Henrico", "Sandston", "New Albany", "Eagle Mountain", "Huntsville", "Odense", "Mesa",
  "DeKalb", "Stanton Springs", "Kansas City", "Aiken", "Jeffersonville", "Richland"];
function botSessions(startDate) {
  return `select $session_id from events
    where timestamp >= toDateTime('${startDate} 00:00:00', '${TZ}') - interval 1 day
      and ((toFloat(properties.$viewport_width) = 1050 and toFloat(properties.$viewport_height) in (1837, 1893))
        or properties.$geoip_city_name in (${META_DC_CITIES.map((c) => `'${c}'`).join(", ")}))
    group by $session_id`;
}

// PostHogは混雑時に503/429を返すので、少し待って再試行する
async function hogql(token, projectId, query, attempt = 1) {
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  if ((res.status === 503 || res.status === 429) && attempt < 5) {
    await new Promise((r) => setTimeout(r, attempt * 15000));
    return hogql(token, projectId, query, attempt + 1);
  }
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(`PostHog Query API失敗: ${res.status} ${JSON.stringify(data)}`);
  return data.results || [];
}

// 1行 = 日付×入口LP×UTM×チャネル のセッション集計
//   FV離脱: 1ページだけ見て、1画面の半分もスクロールせずに離脱したセッション
//          ($pageleaveが届かないモバイルのセッションは数えられないため、実際より少なめに出る)
//   hacomono遷移 / LINEクリック: そのリンクを1回以上クリックしたセッション
//   ウィジェット到達 / 操作: widget_view / widget_interact を1回以上送ったセッション(funnel-tracking.njk)
async function fetchAccessRows(config, startDate) {
  const token = readSecret("posthog-personal-api-key.txt");
  const query = `
    select toString(toDate(toTimeZone(s.$start_timestamp, '${TZ}'))) d, s.$entry_pathname p,
      s.$entry_utm_source src, s.$entry_utm_medium med, s.$entry_utm_campaign cmp, s.$entry_utm_content cnt,
      s.$channel_type ch,
      count() n,
      countIf(s.$pageview_count <= 1 and e.fv = 1) fv_exit,
      countIf(e.haco > 0) haco,
      countIf(e.line > 0) line,
      countIf(e.wv > 0) widget_view,
      countIf(e.wi > 0) widget_interact
    from sessions s
    left join (
      select $session_id sid,
        max(event = '$pageleave' and toFloat(properties.$prev_pageview_max_scroll) < toFloat(properties.$viewport_height) * 0.5) fv,
        countIf(event = '$autocapture' and elements_chain like '%hacomono.jp%') haco,
        countIf(event = '$autocapture' and (elements_chain like '%line.me%' or elements_chain like '%lin.ee%' or elements_chain like '%/auth/line%')) line,
        countIf(event = 'widget_view') wv,
        countIf(event = 'widget_interact') wi
      from events
      where timestamp >= toDateTime('${startDate} 00:00:00', '${TZ}') - interval 1 day and properties.$host = '${SITE_HOST}'
      group by sid
    ) e on e.sid = s.session_id
    where s.$start_timestamp >= toDateTime('${startDate} 00:00:00', '${TZ}')
      and (s.$entry_current_url like 'https://${SITE_HOST}%' or s.$entry_current_url like 'https://bookom.jp/reservation%')
      and s.session_id not in (${botSessions(startDate)})
    group by d, p, src, med, cmp, cnt, ch
    order by d, n desc
    limit 10000`;
  const rows = await hogql(token, config.posthogProjectId, query);
  return rows.map(([date, p, src, med, cmp, cnt, channel, n, fvExit, haco, line, widgetView, widgetInteract]) => ({
    date,
    lp: normalizePath(p),
    src: decode(src),
    med: decode(med),
    cmp: decode(cmp),
    cnt: decode(cnt),
    channel: channel || "",
    sessions: n,
    fvExit,
    haco,
    line,
    widgetView,
    widgetInteract,
  }));
}

// 1行 = 日付×LP×セクション。そのセクションまで画面に表示されたセッション数
// funnel-tracking.njk(lp_path/section_index/section)と、cp5〜9lpの ix-section-tracking.njk
// (page_path/section_order/section_id)の両方の形式を受け付ける
async function fetchSectionRows(config, startDate) {
  const token = readSecret("posthog-personal-api-key.txt");
  const query = `
    select toString(toDate(toTimeZone(timestamp, '${TZ}'))) d, coalesce(properties.lp_path, properties.page_path) p,
      toInt(coalesce(properties.section_index, properties.section_order)) idx,
      any(coalesce(properties.section, properties.section_id)) sec, uniq($session_id) n
    from events
    where event = 'lp_section_view' and properties.$host = '${SITE_HOST}'
      and $session_id not in (${botSessions(startDate)})
      and timestamp >= toDateTime('${startDate} 00:00:00', '${TZ}')
    group by d, p, idx
    order by d, p, idx
    limit 10000`;
  const rows = await hogql(token, config.posthogProjectId, query);
  return rows.map(([date, p, idx, name, n]) => [date, normalizePath(p), idx, name, n]);
}

// 1行 = 日付×LP。そのページで各位置までスクロールしたセッション数。
// ページの長さに対する割合なので、長さの違うLP同士より、同じLPの期間比較に向く。
// $pageleaveが届かないモバイルのセッションは含まれない
async function fetchScrollRows(config, startDate) {
  const token = readSecret("posthog-personal-api-key.txt");
  const query = `
    select d, p, count() n, countIf(sc >= 0.25) r25, countIf(sc >= 0.5) r50, countIf(sc >= 0.75) r75, countIf(sc >= 0.95) r100
    from (
      select toString(toDate(toTimeZone(timestamp, '${TZ}'))) d, properties.$pathname p, $session_id sid,
        max(toFloat(properties.$prev_pageview_max_scroll_percentage)) sc
      from events
      where event = '$pageleave' and properties.$host = '${SITE_HOST}'
        and properties.$prev_pageview_max_scroll_percentage is not null
        and $session_id not in (${botSessions(startDate)})
        and timestamp >= toDateTime('${startDate} 00:00:00', '${TZ}')
      group by d, p, sid
    )
    group by d, p
    limit 10000`;
  const rows = await hogql(token, config.posthogProjectId, query);
  // "/cp4lp" と "/cp4lp/" を合算する
  const merged = new Map();
  for (const [date, p, ...counts] of rows) {
    const key = `${date}|${normalizePath(p)}`;
    const prev = merged.get(key) || [date, normalizePath(p), 0, 0, 0, 0, 0];
    counts.forEach((c, i) => (prev[i + 2] += Number(c)));
    merged.set(key, prev);
  }
  return [...merged.values()].sort((a, b) => (a[0] + a[1]).localeCompare(b[0] + b[1]));
}

async function writeScrollRows(sheets, spreadsheetId, startDate, scrollRows) {
  const header = ["日付", "LPパス", "計測セッション", "25%到達", "50%到達", "75%到達", "最後まで"];
  const existing = (await readRange(sheets, spreadsheetId, `${SHEET_SCROLL}!A2:G`)).filter(
    (r) => r.some((v) => v !== "") && sheetDate(r[0]) < startDate,
  );
  const merged = [...existing.map((r) => [sheetDate(r[0]), ...r.slice(1)]), ...scrollRows];
  await rewriteSheet(sheets, spreadsheetId, SHEET_SCROLL, header, merged);
}

// ChatGPTなどのAI検索から来た人。ChatGPTは紹介したURLに utm_source=chatgpt.com を足すので、
// GBPのリンク(utm_campaign=gbp)を紹介された場合もMEOではなくAI検索として数える
const AI_DOMAINS = ["chatgpt.com", "chat.openai.com", "perplexity.ai", "gemini.google.com", "copilot.microsoft.com", "claude.ai"];
const AI_SOURCE_SQL = `(s.$entry_utm_source in (${AI_DOMAINS.map((d) => `'${d}'`).join(", ")})
          or s.$entry_referring_domain in (${AI_DOMAINS.map((d) => `'${d}'`).join(", ")}) or s.$channel_type = 'AI')`;

// 1行 = 日付×入口LP×流入元。経路マスタに登録していない流入(SNS投稿・直接など)も含めて、流入元の種類で分ける。
//   FV離脱: 入口のページで、1画面目より下にスクロールせずに離脱(ピクセルで判定。長いページでも不利にならない)
//   スクロール到達: 入口のページの長さに対する割合
async function fetchLpSourceRows(config, startDate) {
  const token = readSecret("posthog-personal-api-key.txt");
  const query = `
    select toString(toDate(toTimeZone(s.$start_timestamp, '${TZ}'))) d,
      replaceRegexpOne(s.$entry_pathname, '/$', '') lp,
      multiIf(
        ${AI_SOURCE_SQL}, 'AI検索',
        s.$entry_utm_campaign = 'gbp', 'MEO',
        s.$entry_utm_medium in ('print', 'qr', 'flyer', 'offline', 'poster'), 'チラシ・店頭',
        s.$channel_type = 'Paid Search' or (s.$entry_utm_source = 'google' and s.$entry_utm_medium = 'cpc'), 'Google広告',
        s.$channel_type in ('Paid Social', 'Paid Unknown'), 'Meta広告',
        s.$channel_type = 'Organic Search', 'SEO',
        s.$channel_type = 'Organic Social', 'SNS投稿',
        s.$channel_type = 'Direct', '直接',
        'その他') src,
      s.$entry_utm_campaign cmp,
      count() n,
      countIf(e.px is not null) fv_measured,
      countIf(e.px is not null and e.px < e.vh) fv_exit,
      countIf(e.pct is not null) sc_measured,
      countIf(e.pct >= 0.25) r25, countIf(e.pct >= 0.5) r50, countIf(e.pct >= 0.75) r75, countIf(e.pct >= 0.95) r100,
      countIf(a.haco > 0) haco, countIf(a.line > 0) line, countIf(a.wv > 0) wv, countIf(a.wi > 0) wi, countIf(a.wr > 0) wr
    from sessions s
    left join (
      select $session_id sid, replaceRegexpOne(properties.$pathname, '/$', '') p,
        max(toFloat(properties.$prev_pageview_max_scroll)) px, max(toFloat(properties.$viewport_height)) vh,
        max(toFloat(properties.$prev_pageview_max_scroll_percentage)) pct
      from events
      where event = '$pageleave' and properties.$host = '${SITE_HOST}'
        and timestamp >= toDateTime('${startDate} 00:00:00', '${TZ}') - interval 1 day
      group by sid, p
    ) e on e.sid = s.session_id and e.p = replaceRegexpOne(s.$entry_pathname, '/$', '')
    left join (
      select $session_id sid,
        countIf(event = '$autocapture' and elements_chain like '%hacomono.jp%') haco,
        countIf(event = '$autocapture' and (elements_chain like '%line.me%' or elements_chain like '%lin.ee%' or elements_chain like '%/auth/line%')) line,
        countIf(event = 'widget_view') wv, countIf(event = 'widget_interact') wi,
        countIf(event = 'widget_reservation_completed') wr
      from events
      where properties.$host = '${SITE_HOST}' and timestamp >= toDateTime('${startDate} 00:00:00', '${TZ}') - interval 1 day
      group by sid
    ) a on a.sid = s.session_id
    where s.$start_timestamp >= toDateTime('${startDate} 00:00:00', '${TZ}')
      and s.$entry_current_url like 'https://${SITE_HOST}%'
      and s.session_id not in (${botSessions(startDate)})
    group by d, lp, src, cmp
    order by d, lp, src, cmp
    limit 20000`;
  const rows = await hogql(token, config.posthogProjectId, query);
  return rows.map(([date, lp, src, cmp, ...counts]) => [date, normalizePath(lp || "/"), src, ...counts.map(Number), decode(cmp)]);
}

async function writeLpSourceRows(sheets, spreadsheetId, startDate, rows) {
  const header = ["日付", "LPパス", "流入元", "訪問", "FV計測", "FV離脱", "スクロール計測", "25%到達", "50%到達", "75%到達", "最後まで",
    "hacomono遷移", "LINEクリック", "ウィジェット到達", "ウィジェット操作", "ウィジェット予約完了", "utm_campaign"];
  const existing = (await readRange(sheets, spreadsheetId, `${SHEET_LP_SOURCE}!A2:Q`)).filter(
    (r) => r.some((v) => v !== "") && sheetDate(r[0]) < startDate,
  );
  const merged = [...existing.map((r) => [sheetDate(r[0]), ...r.slice(1)]), ...rows];
  await rewriteSheet(sheets, spreadsheetId, SHEET_LP_SOURCE, header, merged);
}

// Meta広告から来た人の、配信面(Instagramストーリーズ・フィードなど)ごとのLPでの動き。
// 配信面は、広告のURLパラメータ utm_term={{placement}}(2026-10-26〜)で判定する。それより前の訪問や
// utm_term が配信面でない訪問は、来訪元のアプリ(参照元ドメイン)からプラットフォームだけ判定する。
// 名前は meta-placement-sync.mjs の データ_Meta配信面 とそろえる(「配信面分析」シートで突き合わせるため)
function placementLabel(term, referrer) {
  const t = String(term || "");
  const rules = [
    [/instagram.*stor/i, "Instagram", "Instagram ストーリーズ"], [/instagram.*reel/i, "Instagram", "Instagram リール"],
    [/instagram.*explore/i, "Instagram", "Instagram 発見"], [/instagram.*profile/i, "Instagram", "Instagram プロフィール"],
    [/instagram.*feed/i, "Instagram", "Instagram フィード"], [/facebook.*reel/i, "Facebook", "Facebook リール"],
    [/facebook.*stor/i, "Facebook", "Facebook ストーリーズ"], [/facebook.*feed/i, "Facebook", "Facebook フィード"],
    [/threads/i, "Threads", "Threads"], [/messenger/i, "Messenger", "Messenger"], [/audience/i, "Audience Network", "Audience Network"],
  ];
  for (const [re, platform, placement] of rules) if (re.test(t)) return [platform, placement, "utm_term"];
  const r = String(referrer || "");
  const platform = /instagram/.test(r) ? "Instagram" : /threads/.test(r) ? "Threads" : /facebook/.test(r) ? "Facebook" : "不明";
  return [platform, `${platform}（面不明）`, "参照元"];
}

async function fetchPlacementRows(config, startDate) {
  const token = readSecret("posthog-personal-api-key.txt");
  const query = `
    select toString(toDate(toTimeZone(s.$start_timestamp, '${TZ}'))) d,
      replaceRegexpOne(s.$entry_pathname, '/$', '') lp, s.$entry_utm_campaign cmp, s.$entry_utm_term term, s.$entry_referring_domain ref,
      count() n, countIf(a.secs <= 1) fv_only, countIf(a.price > 0) price,
      countIf(a.wv > 0) wv, countIf(a.wi > 0) wi, countIf(a.wr > 0) wr
    from sessions s
    left join (
      select $session_id sid,
        uniqIf(coalesce(properties.section_id, properties.section), event = 'lp_section_view') secs,
        countIf(event = 'lp_section_view' and coalesce(properties.section_id, properties.section) in ('price', 'pricing')) price,
        countIf(event = 'widget_view') wv, countIf(event = 'widget_interact') wi, countIf(event = 'widget_reservation_completed') wr
      from events
      where properties.$host = '${SITE_HOST}' and timestamp >= toDateTime('${startDate} 00:00:00', '${TZ}') - interval 1 day
      group by sid
    ) a on a.sid = s.session_id
    where s.$start_timestamp >= toDateTime('${startDate} 00:00:00', '${TZ}')
      and s.$entry_current_url like 'https://${SITE_HOST}%'
      and s.$entry_utm_source in ('facebook', 'fb', 'ig', 'instagram')
      and s.session_id not in (${botSessions(startDate)})
    group by d, lp, cmp, term, ref
    limit 20000`;
  const rows = await hogql(token, config.posthogProjectId, query);
  const agg = new Map();
  for (const [date, lp, cmp, term, ref, ...counts] of rows) {
    const [platform, placement, how] = placementLabel(decode(term), ref);
    const key = [date, normalizePath(lp || "/"), decode(cmp), platform, placement, how].join("\t");
    const sum = agg.get(key) || [0, 0, 0, 0, 0, 0];
    counts.forEach((c, i) => (sum[i] += Number(c)));
    agg.set(key, sum);
  }
  return [...agg.entries()].map(([k, v]) => {
    const [date, lp, cmp, platform, placement, how] = k.split("\t");
    return [date, lp, cmp, platform, placement, ...v, how];
  }).sort((a, b) => (a[0] + a[1] + a[4]).localeCompare(b[0] + b[1] + b[4]));
}

async function writePlacementRows(sheets, spreadsheetId, startDate, rows) {
  const header = ["日付", "LPパス", "utm_campaign", "プラットフォーム", "配信面", "訪問", "FVだけで離脱", "料金到達",
    "ウィジェット到達", "ウィジェット操作", "ウィジェット予約完了", "配信面の判定"];
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
  if (!meta.data.sheets.some((s) => s.properties.title === SHEET_PLACEMENT)) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: SHEET_PLACEMENT } } }] } });
  }
  const existing = (await readRange(sheets, spreadsheetId, `${SHEET_PLACEMENT}!A2:L`)).filter(
    (r) => r.some((v) => v !== "") && sheetDate(r[0]) < startDate,
  );
  const merged = [...existing.map((r) => [sheetDate(r[0]), ...r.slice(1)]), ...rows];
  await rewriteSheet(sheets, spreadsheetId, SHEET_PLACEMENT, header, merged);
}

// ---------------- 経路マスタとの突き合わせ ----------------

// LINE refが入っている経路マスタの行。同じrefが複数行にある場合(google_hpをSEOとMEOで分けるなど)は
// 友だちのmetadataに残ったutm_campaignで振り分ける
function parseLineRoutes(values) {
  return values
    .slice(1)
    .filter((r) => r[0] && r[11])
    .map((r) => ({ id: r[0], ref: r[11].trim(), campaign: (r[9] || "").trim().toLowerCase() }));
}

// 経路付きURLを通らずに追加された友だちは、LINE Harnessのmetadata.manual_ref(オーナーの申告で手動で付けたref)を使う
function friendRef(friend) {
  return friend.refCode || friend.metadata?.manual_ref || "";
}

function resolveLineRoute(friend, lineRoutes) {
  const ref = friendRef(friend);
  if (!ref) return "ref無し";
  const candidates = lineRoutes.filter((m) => m.ref === ref);
  if (!candidates.length) return "未登録ref";
  const campaign = String(friend.metadata?.utm_campaign || "").toLowerCase();
  const exact = candidates.find((m) => m.campaign && !m.campaign.includes("{{") && m.campaign === campaign);
  const generic = candidates.find((m) => !m.campaign || m.campaign.includes("{{"));
  return (exact || generic || candidates[0]).id;
}

// 経路マスタの行: A経路ID C区分 F遷移先の種類 G遷移先LP H〜K utm
function parseMaster(values) {
  return values
    .slice(1)
    .filter((r) => r[0] && (r[5] === "LP" || r[5] === "BOOKOM"))
    .map((r) => ({
      id: r[0],
      kind: r[2] || "",
      lp: normalizePath(r[6] || ""),
      utm: [r[7], r[8], r[9], r[10]].map((v) => (v || "").trim().toLowerCase()),
    }));
}

// UTMなしの経路(SEOなど)は、PostHogのチャネル種別で振り分ける
// (BOOKOMの予約ページ /reservation を入口にした広告流入も、経路マスタの「遷移先の種類=BOOKOM」で割り当てる)
const CHANNEL_BY_KIND = { SEO: "Organic Search" };

// 最も条件が細かく一致した経路を採用する。"{{campaign.name}}" のような差し込み値は「何でも可」として扱う
function resolveRoute(row, master) {
  const values = [row.src, row.med, row.cmp, row.cnt].map((v) => v.toLowerCase());
  let best = null;
  let bestScore = -1;
  for (const m of master) {
    if (m.lp && m.lp !== row.lp) continue;
    const hasUtm = m.utm.some(Boolean);
    let score = m.lp ? 1 : 0;
    if (hasUtm) {
      let ok = true;
      m.utm.forEach((v, i) => {
        if (!v || v.includes("{{")) return;
        // 「*」は任意の文字列(例: *ix001 = 末尾がix001のコンテンツ名)。それ以外は完全一致
        const matched = v.includes("*")
          ? new RegExp(`^${v.split("*").map((t) => t.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i").test(values[i])
          : v === values[i];
        if (!matched) ok = false;
        else score += 2;
      });
      if (!ok || !values[0]) continue;
    } else {
      if (values[0]) continue;
      const channel = CHANNEL_BY_KIND[m.kind];
      if (!channel || channel !== row.channel) continue;
    }
    if (score > bestScore) {
      best = m.id;
      bestScore = score;
    }
  }
  return best || "";
}

// ---------------- LINE Harness ----------------

async function fetchFriends(config) {
  const key = readSecret("line-harness-api-key.txt");
  const base = config.lineHarnessUrl.replace(/\/$/, "");
  const friends = [];
  for (let offset = 0; ; offset += 100) {
    const res = await fetch(`${base}/api/friends?limit=100&offset=${offset}&sortBy=createdAt&sortOrder=asc`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = await res.json();
    if (!res.ok || !body.success) throw new Error(`LINE Harness API失敗: ${res.status} ${JSON.stringify(body)}`);
    friends.push(...body.data.items);
    if (!body.data.hasNextPage) break;
  }
  return friends;
}

// ---------------- Google Sheets ----------------

function getGoogleAuth() {
  const cj = JSON.parse(readSecret("google-oauth-client.json"));
  const { client_id, client_secret } = cj.installed ?? cj.web ?? cj;
  const tokens = JSON.parse(readSecret("google-oauth-token.json"));
  const auth = new google.auth.OAuth2(client_id, client_secret);
  auth.setCredentials(tokens);
  return auth;
}

async function getSheets() {
  return google.sheets({ version: "v4", auth: getGoogleAuth() });
}

// ---------------- GA4 (CV) ----------------

// GA4の「(not set)」「(direct)」などは、経路マスタの判定では「UTMなし」として扱う
function ga4Value(v) {
  const t = decode(v || "");
  return /^\((not set|direct|none|data not available)\)$/i.test(t) || /^\(direct\) \/ \(none\)$/i.test(t) ? "" : t;
}

// 1行 = 日付×イベント×セッションの流入元(×入口LP)。CV件数をGA4から取り、経路IDを割り当てる。
// hacomono側のセッションは、ドメイン間の引き継ぎが効いている場合だけLPの流入元を引き継ぐ。
// 引き継げない(入口がhacomono/BOOKOMなど)ものは、経路IDを空にして「未特定」として残す。
async function fetchCvRows(config, startDate, master) {
  const propertyId = config.ga4PropertyId;
  if (!propertyId) throw new Error("scripts/seo-config.json に ga4PropertyId が設定されていません");
  const analyticsdata = google.analyticsdata({ version: "v1beta", auth: getGoogleAuth() });
  const res = await analyticsdata.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate, endDate: "today" }],
      dimensions: [
        { name: "date" }, { name: "eventName" }, { name: "sessionSource" }, { name: "sessionMedium" },
        { name: "sessionCampaignName" }, { name: "sessionManualAdContent" }, { name: "sessionDefaultChannelGroup" },
        { name: "landingPage" },
      ],
      metrics: [{ name: "eventCount" }],
      dimensionFilter: { filter: { fieldName: "eventName", inListFilter: { values: Object.keys(CV_EVENTS) } } },
      limit: 10000,
    },
  });
  const lpPaths = new Set(master.map((m) => m.lp).filter(Boolean));
  const out = [];
  for (const r of res.data.rows || []) {
    const [d, ev, src, med, cmp, cnt, channel, landing] = r.dimensionValues.map((v) => v.value);
    const conf = CV_EVENTS[ev];
    const date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    if (!conf || (conf.since && date < conf.since)) continue;
    const lpRaw = normalizePath(landing);
    const lp = lpPaths.has(lpRaw) ? lpRaw : "";
    const row = { lp, src: ga4Value(src), med: ga4Value(med), cmp: ga4Value(cmp), cnt: ga4Value(cnt), channel: channel || "" };
    const routeId = resolveRoute(row, master);
    const origin = [src, med].filter(Boolean).join(" / ");
    out.push({
      date, routeId, lp: lp || (landing && landing !== "(not set)" ? landing : ""), count: Number(r.metricValues[0].value),
      memo: `${conf.label}(${ev})${routeId ? "" : ` 流入:${origin || "不明"}`}`,
    });
  }
  return out;
}

async function readRange(sheets, spreadsheetId, range) {
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

async function rewriteSheet(sheets, spreadsheetId, sheetName, header, rows) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${sheetName}!A2:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${sheetName}!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [header, ...rows] },
  });
}

// "2026/09/24" "2026-09-24" どちらの表示形式でも比較できるようにする
function sheetDate(v) {
  return String(v || "").replace(/\//g, "-").slice(0, 10);
}

// ---------------- main ----------------

async function main() {
  const config = loadConfig();
  const start = new Date(Date.now() - (DAYS - 1) * 86400000);
  const startDate = toDateString(start);
  const spreadsheetId = config.dashboardSheetId;
  const sheets = DRY_RUN ? null : await getSheets();

  if (SCROLL_SINCE) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(SCROLL_SINCE)) throw new Error("--scroll-since は YYYY-MM-DD で指定してください");
    const [scrollRows, lpSourceRows, placementRows] = await Promise.all([
      fetchScrollRows(config, SCROLL_SINCE),
      fetchLpSourceRows(config, SCROLL_SINCE),
      fetchPlacementRows(config, SCROLL_SINCE),
    ]);
    if (DRY_RUN) {
      console.log(`[dry-run] データ_スクロール ${SCROLL_SINCE}〜: ${scrollRows.length}行`);
      console.log(`[dry-run] データ_LP流入元 ${SCROLL_SINCE}〜: ${lpSourceRows.length}行`);
      console.log(`[dry-run] データ_広告配信面 ${SCROLL_SINCE}〜: ${placementRows.length}行`);
      for (const row of placementRows.slice(0, 10)) console.log("  " + row.join(" | "));
      for (const row of lpSourceRows.slice(0, 10)) console.log("  " + row.join(" | "));
      return;
    }
    await writeScrollRows(sheets, spreadsheetId, SCROLL_SINCE, scrollRows);
    await writeLpSourceRows(sheets, spreadsheetId, SCROLL_SINCE, lpSourceRows);
    await writePlacementRows(sheets, spreadsheetId, SCROLL_SINCE, placementRows);
    console.log(`データ_スクロール: ${SCROLL_SINCE}〜 ${scrollRows.length}行`);
    console.log(`データ_広告配信面: ${SCROLL_SINCE}〜 ${placementRows.length}行`);
    console.log(`データ_LP流入元: ${SCROLL_SINCE}〜 ${lpSourceRows.length}行`);
    return;
  }

  const masterValues = sheets ? await readRange(sheets, spreadsheetId, `${SHEET_MASTER}!A1:L`) : [];
  const master = parseMaster(masterValues);
  const lineRoutes = parseLineRoutes(masterValues);

  const [accessRows, sectionRows, scrollRows, lpSourceRows, placementRows, friends] = await Promise.all([
    fetchAccessRows(config, startDate),
    fetchSectionRows(config, startDate),
    fetchScrollRows(config, startDate),
    fetchLpSourceRows(config, startDate),
    fetchPlacementRows(config, startDate),
    // LINE Harnessが落ちていてもPostHog・GA4の同期は止めない(データ_LINE追加は前回のまま残す)
    fetchFriends(config).catch((err) => {
      console.error(`警告: LINE Harnessの取得に失敗しました(データ_LINE追加は更新しません): ${err.message}`);
      return null;
    }),
  ]);

  const newAccess = accessRows.map((r) => [
    r.date, r.lp, resolveRoute(r, master), r.src, r.med, r.cmp, r.cnt,
    r.sessions, r.fvExit, r.widgetView, r.widgetInteract, r.haco, r.line, "PostHog",
  ]);

  // 経路IDはrefとUTMからここで決め、経路名はシート側の数式で経路マスタから引く
  const lineHeader = ["追加日時", "LINE ref", "経路ID（自動）", "経路名（自動）", "friend_id（LINE Harness）", "ブロック済み", "体験予約済み", "入会済み"];
  const lineRows = (friends || []).map((f, i) => {
    const r = i + 2;
    const tags = new Set((f.tags || []).map((t) => t.name));
    return [
      f.createdAt.replace("T", " ").slice(0, 16),
      friendRef(f),
      resolveLineRoute(f, lineRoutes),
      `=IFERROR(INDEX(${SHEET_MASTER}!$D:$D,MATCH(C${r},${SHEET_MASTER}!$A:$A,0)),"")`,
      f.id,
      f.isFollowing ? "" : "TRUE",
      tags.has(TAG_BOOKED) ? "TRUE" : "",
      tags.has(TAG_MEMBER) ? "TRUE" : "",
    ];
  });

  let cvRows = [];
  let cvError = null;
  try {
    cvRows = await fetchCvRows(config, startDate, master);
  } catch (err) {
    cvError = err.message;
    console.error(`警告: GA4のCV取得に失敗しました(他のシートの同期は続行します): ${cvError}`);
  }

  if (DRY_RUN) {
    console.log(`[dry-run] データ_アクセス ${startDate}〜: ${newAccess.length}行`);
    for (const row of newAccess.slice(0, 15)) console.log("  " + row.join(" | "));
    console.log(`[dry-run] データ_セクション: ${sectionRows.length}行`);
    for (const row of sectionRows.slice(0, 10)) console.log("  " + row.join(" | "));
    const withRef = (friends || []).filter((f) => f.refCode).length;
    console.log(`[dry-run] データ_LINE追加: ${lineRows.length}件（ref付き ${withRef}件）`);
    console.log(`[dry-run] データ_CV ${startDate}〜: ${cvRows.length}行`);
    for (const r of cvRows.slice(0, 15)) console.log(`  ${r.date} | 体験予約 | ${r.routeId || "(未特定)"} | ${r.lp} | ${r.count} | GA4 | ${r.memo}`);
    return;
  }

  // 指定期間のPostHog行だけ入れ替え、手入力行・期間外の行は残す
  const accessHeader = ["日付", "LPパス", "経路ID", "utm_source", "utm_medium", "utm_campaign", "utm_content", "訪問数", "FVで離脱", "ウィジェット到達", "ウィジェット操作", "hacomono遷移", "LINEボタンクリック", "ソース"];
  const existing = (await readRange(sheets, spreadsheetId, `${SHEET_ACCESS}!A2:N`)).filter(
    (r) => r.some((v) => v !== "") && !(r[13] === "PostHog" && sheetDate(r[0]) >= startDate),
  );
  const merged = [...existing.map((r) => [sheetDate(r[0]), ...r.slice(1)]), ...newAccess].sort((a, b) =>
    String(a[0]).localeCompare(String(b[0])),
  );
  await rewriteSheet(sheets, spreadsheetId, SHEET_ACCESS, accessHeader, merged);

  const sectionHeader = ["日付", "LPパス", "順番", "セクション", "到達セッション"];
  const sectionExisting = (await readRange(sheets, spreadsheetId, `${SHEET_SECTION}!A2:E`)).filter(
    (r) => r.some((v) => v !== "") && sheetDate(r[0]) < startDate,
  );
  const sectionMerged = [...sectionExisting.map((r) => [sheetDate(r[0]), ...r.slice(1)]), ...sectionRows];
  await rewriteSheet(sheets, spreadsheetId, SHEET_SECTION, sectionHeader, sectionMerged);
  await writeScrollRows(sheets, spreadsheetId, startDate, scrollRows);
  await writeLpSourceRows(sheets, spreadsheetId, startDate, lpSourceRows);
  await writePlacementRows(sheets, spreadsheetId, startDate, placementRows);
  if (friends) await rewriteSheet(sheets, spreadsheetId, SHEET_LINE, lineHeader, lineRows);

  if (!cvError) {
    const cvHeader = ["日付", "CV種別", "経路ID", "LPパス", "件数", "ソース", "会員ID/予約ID（任意）", "メモ（予約時アンケートの回答など）"];
    const cvExisting = (await readRange(sheets, spreadsheetId, `${SHEET_CV}!A2:H`)).filter(
      (r) => r.some((v) => v !== "") && !(r[5] === "GA4" && sheetDate(r[0]) >= startDate),
    );
    // 手入力で経路を割り当てたCV(ソース=手入力、メモが「GA4未特定分の割当」で始まる行)は、
    // 同じ日のGA4「経路を特定できなかった分」から差し引く(同じCVが二重に数えられないように)
    const assigned = {};
    for (const r of cvExisting) {
      if (r[5] === "手入力" && String(r[7] || "").startsWith("GA4未特定分の割当")) {
        const d = sheetDate(r[0]);
        assigned[d] = (assigned[d] || 0) + Number(r[4] || 0);
      }
    }
    const cvAdjusted = [];
    for (const r of cvRows) {
      let count = r.count;
      if (!r.routeId && assigned[r.date] > 0) {
        const take = Math.min(count, assigned[r.date]);
        count -= take;
        assigned[r.date] -= take;
      }
      if (count > 0) cvAdjusted.push({ ...r, count });
    }
    const cvNew = cvAdjusted.map((r) => [r.date, "体験予約", r.routeId, r.lp, r.count, "GA4", "", r.memo]);
    const cvMerged = [...cvExisting.map((r) => [sheetDate(r[0]), ...r.slice(1)]), ...cvNew].sort((a, b) =>
      String(a[0]).localeCompare(String(b[0])),
    );
    await rewriteSheet(sheets, spreadsheetId, SHEET_CV, cvHeader, cvMerged);
    const cvTotal = cvAdjusted.reduce((s, r) => s + r.count, 0);
    const cvUnmatched = cvAdjusted.filter((r) => !r.routeId).reduce((s, r) => s + r.count, 0);
    console.log(`データ_CV: ${startDate}〜 ${cvRows.length}行（CV ${cvTotal}件、経路を特定できなかった分 ${cvUnmatched}件）`);
  }

  const unmatched = newAccess.filter((r) => !r[2]).reduce((s, r) => s + r[7], 0);
  const total = newAccess.reduce((s, r) => s + r[7], 0);
  console.log(`データ_アクセス: ${startDate}〜 ${newAccess.length}行（${total}セッション、経路マスタ未登録 ${unmatched}セッション）`);
  console.log(`データ_セクション: ${sectionRows.length}行`);
  console.log(`データ_スクロール: ${startDate}〜 ${scrollRows.length}行`);
  console.log(`データ_LP流入元: ${startDate}〜 ${lpSourceRows.length}行`);
  console.log(`データ_広告配信面: ${startDate}〜 ${placementRows.length}行`);
  console.log(friends ? `データ_LINE追加: ${lineRows.length}件` : "データ_LINE追加: 取得失敗のため前回のまま");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
