// GSC・GA4のデータを取得してSEOレポート(PDF)を生成するスクリプト。
// 週次スケジュールタスクから実行される。見た目は scripts/report-design-kit.mjs の共通デザインキットを使用。
//
// 前提:
//   - OAuthクライアント情報が ~/.zennu-lp-secrets/google-oauth-client.json にある
//   - 認証済みrefresh_tokenが ~/.zennu-lp-secrets/google-oauth-token.json にある
//     (初回のみ `node scripts/oauth-authorize.mjs` で取得)
//   - GA4のプロパティID(数値)を scripts/seo-config.json に設定済み
//
// 実行:
//   1) node scripts/seo-report.mjs --fetch
//        Search Console/GA4から実データを取得し scripts/seo-report-data.json に書き出す(insightsは空配列)。
//        この後、Claudeが内容を分析して同ファイルの insights 配列に所見(3〜5個)を書き加える。
//   2) node scripts/seo-report.mjs [出力.pdf] [--send-chatwork]
//        scripts/seo-report-data.json (無ければ .example.json) を読み込みPDFを生成する。

import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { sendChatworkFile } from "./notify-chatwork.mjs";
import { CAT, INK_MUTED, num, pct, donutChart, hBarChart, kpiTile, pageHeader, card, callout, tableHtml, wrapDocument, renderPdfFromHtml } from "./report-design-kit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const SECRETS_DIR = path.join(os.homedir(), ".zennu-lp-secrets");
const CLIENT_PATH = path.join(SECRETS_DIR, "google-oauth-client.json");
const TOKEN_PATH = path.join(SECRETS_DIR, "google-oauth-token.json");
const CONFIG_PATH = path.join(__dirname, "seo-config.json");
const DATA_PATH = path.join(__dirname, "seo-report-data.json");
const SAMPLE_DATA_PATH = path.join(__dirname, "seo-report-data.example.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`設定ファイルが見つかりません: ${CONFIG_PATH}\nga4PropertyId と siteUrl を書いて作成してください。`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

async function getAuth() {
  if (!fs.existsSync(CLIENT_PATH)) {
    throw new Error(`OAuthクライアント情報が見つかりません: ${CLIENT_PATH}`);
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`認証トークンが見つかりません: ${TOKEN_PATH}\n先に node scripts/oauth-authorize.mjs を実行してください。`);
  }
  const { client_id, client_secret } = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));

  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

async function fetchSearchConsole(auth, siteUrl) {
  const searchconsole = google.searchconsole({ version: "v1", auth });
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 28);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const [byQuery, byPage] = await Promise.all([
    searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: { startDate: fmt(startDate), endDate: fmt(endDate), dimensions: ["query"], rowLimit: 50 },
    }),
    searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: { startDate: fmt(startDate), endDate: fmt(endDate), dimensions: ["page"], rowLimit: 50 },
    }),
  ]);

  return {
    period: { start: fmt(startDate), end: fmt(endDate) },
    queries: (byQuery.data.rows || []).map((r) => ({
      query: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr * 100,
      position: r.position,
    })),
    pages: (byPage.data.rows || []).map((r) => ({
      page: r.keys[0].replace(siteUrl, "/"),
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr * 100,
      position: r.position,
    })),
  };
}

async function fetchGA4(auth, propertyId) {
  const analyticsdata = google.analyticsdata({ version: "v1beta", auth });

  // 同じGTMコンテナがhacomonoの予約ウィジェット側ドメインにも埋め込まれているため、
  // このプロパティにはLP以外(hacomono内部ページ)のヒットも混ざる。
  // SEO用のランディングページ分析はLPドメインだけに絞り込む。
  // (イベント集計は絞り込まない: reserve_completeなどのCVはhacomono側ドメインで
  //  発生するため、絞り込むとコンバージョン数が正しく見えなくなる)
  const LP_HOSTNAME = "lp.zennuwellnessdesign.jp";

  const [landingPages, events] = await Promise.all([
    analyticsdata.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: "28daysAgo", endDate: "today" }],
        dimensions: [{ name: "landingPage" }, { name: "sessionDefaultChannelGroup" }],
        metrics: [{ name: "sessions" }, { name: "engagementRate" }, { name: "conversions" }],
        dimensionFilter: {
          filter: { fieldName: "hostName", stringFilter: { matchType: "EXACT", value: LP_HOSTNAME } },
        },
        orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
        limit: 50,
      },
    }),
    analyticsdata.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: "28daysAgo", endDate: "today" }],
        dimensions: [{ name: "eventName" }],
        metrics: [{ name: "eventCount" }],
        orderBys: [{ metric: { metricName: "eventCount" }, desc: true }],
        limit: 20,
      },
    }),
  ]);

  return {
    landingPages: (landingPages.data.rows || []).map((r) => {
      const [pageVal, channel] = r.dimensionValues.map((v) => v.value);
      const [sessions, engagementRate, conversions] = r.metricValues.map((v) => v.value);
      return { page: pageVal || "(不明)", channel, sessions: +sessions, engagementRate: Number(engagementRate) * 100, conversions: +conversions };
    }),
    events: (events.data.rows || []).map((r) => ({
      name: r.dimensionValues[0].value,
      count: +r.metricValues[0].value,
    })),
  };
}

async function doFetch() {
  const config = loadConfig();
  const auth = await getAuth();
  const [gsc, ga4] = await Promise.all([
    fetchSearchConsole(auth, config.siteUrl),
    fetchGA4(auth, config.ga4PropertyId),
  ]);

  const data = {
    period: gsc.period,
    siteUrl: config.siteUrl,
    queries: gsc.queries,
    pages: gsc.pages,
    landingPages: ga4.landingPages,
    events: ga4.events,
    insights: [],
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.log(`データを書き出しました: ${DATA_PATH}`);
  console.log("このファイルの insights 配列に所見(3〜5個)を追記してから、node scripts/seo-report.mjs を実行してください。");
}

// **強調**記法を<b>に変換する(所見テキストの見出し部分用)
function mdBold(text) {
  return text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

function buildReport(data, { sample = false } = {}) {
  const MAX_ROWS = 15;
  const MAX_LANDING_ROWS = 6;

  const totalClicks = data.queries.reduce((s, q) => s + q.clicks, 0);
  const totalImpressions = data.queries.reduce((s, q) => s + q.impressions, 0);
  const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const top10Count = data.queries.filter((q) => q.position <= 10).length;

  const topByImpressions = [...data.queries].sort((a, b) => b.impressions - a.impressions);
  const chartItems = topByImpressions.slice(0, 8).map((q) => ({
    label: `${q.query}（${q.position.toFixed(1)}位）`,
    value: q.impressions,
  }));

  const channelTotals = {};
  for (const row of data.landingPages) {
    channelTotals[row.channel] = (channelTotals[row.channel] || 0) + row.sessions;
  }
  const channelSegments = Object.entries(channelTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value }));

  const page1 = `
    <div class="sheet">
      ${pageHeader("SEOレポート", `${data.period.start}〜${data.period.end}（Search Console） / 過去28日（GA4）`)}
      <div class="kpi-row">
        ${kpiTile({ label: "総クリック数", value: num(totalClicks) })}
        ${kpiTile({ label: "総表示回数", value: num(totalImpressions) })}
        ${kpiTile({ label: "平均CTR", value: pct(avgCtr, 2) })}
        ${kpiTile({ label: "上位10位以内のクエリ数", value: num(top10Count) })}
      </div>
      <div class="row-2">
        ${card("表示回数上位クエリ（掲載順位付き）", hBarChart(chartItems, { color: CAT.blue, valueFmt: num }))}
        ${card("流入経路別セッション構成比（GA4・過去28日）", donutChart(channelSegments, [CAT.blue, CAT.aqua, CAT.yellow, CAT.magenta, CAT.violet]))}
      </div>
    </div>`;

  const queryRows = topByImpressions.slice(0, MAX_ROWS).map((q) => [
    q.query,
    num(q.clicks),
    num(q.impressions),
    pct(q.ctr, 1),
    q.position.toFixed(1),
  ]);

  const page2 = `
    <div class="sheet">
      ${pageHeader("Search Console: クエリ別詳細", `表示回数上位${Math.min(MAX_ROWS, data.queries.length)}件（全${data.queries.length}件中）`)}
      <div class="row-2">
        ${card(
          "クエリ別実績一覧（表示回数順）",
          tableHtml(["クエリ", "クリック数", "表示回数", "CTR", "平均掲載順位"], queryRows)
        )}
      </div>
    </div>`;

  const pageRows = data.pages.map((p) => [p.page, num(p.clicks), num(p.impressions), pct(p.ctr, 1), p.position.toFixed(1)]);
  const eventItems = [...data.events].sort((a, b) => b.count - a.count).map((e) => ({ label: e.name, value: e.count }));
  const landingRows = [...data.landingPages]
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, MAX_LANDING_ROWS)
    .map((r) => [r.page, r.channel, num(r.sessions), pct(r.engagementRate, 1), num(r.conversions)]);

  const page3 = `
    <div class="sheet">
      ${pageHeader("ページ別実績・イベント", "Search Console・GA4（過去28日）")}
      <div class="row-2" style="margin-bottom:14px;flex:0 0 auto;">
        ${card("Search Console: ページ別実績", tableHtml(["ページ", "クリック数", "表示回数", "CTR", "平均掲載順位"], pageRows))}
        ${card("GA4: イベント数（過去28日）", hBarChart(eventItems, { color: CAT.aqua, valueFmt: num }))}
      </div>
      <div class="row-2">
        ${card(
          `GA4: ランディングページ×流入経路（セッション上位${Math.min(MAX_LANDING_ROWS, data.landingPages.length)}件）`,
          tableHtml(["ページ", "流入経路", "セッション数", "エンゲージメント率", "CV数"], landingRows)
        )}
      </div>
    </div>`;

  const insightsHtml = (data.insights || []).map((text) => callout(mdBold(text))).join("");
  const page4 = `
    <div class="sheet">
      ${pageHeader("所見・次のアクション", `${data.period.start}〜${data.period.end}`)}
      <div class="callout-list">
        ${insightsHtml || `<div style="text-align:center;color:${INK_MUTED};font-size:12px;">所見が未記入です</div>`}
      </div>
    </div>`;

  return wrapDocument([page1, page2, page3, page4], {
    sampleBanner: sample ? "SAMPLE — テンプレート確認用のサンプル数値です" : "",
  });
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--fetch")) {
    await doFetch();
    return;
  }

  const args = rawArgs.filter((a) => a !== "--send-chatwork");
  const shouldSendChatwork = rawArgs.includes("--send-chatwork");

  const usingSample = !fs.existsSync(DATA_PATH);
  const data = JSON.parse(fs.readFileSync(usingSample ? SAMPLE_DATA_PATH : DATA_PATH, "utf-8"));
  const html = buildReport(data, { sample: usingSample });

  const outDir = path.join(REPO_ROOT, "docs", "seo-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outPath = args[0] || path.join(outDir, `${today}.pdf`);

  await renderPdfFromHtml(html, outPath);
  console.log(`レポートを生成しました: ${outPath}`);
  if (usingSample) {
    console.log("注意: seo-report-data.json が無いため、サンプルデータで生成しました。");
  }

  if (shouldSendChatwork) {
    const totalClicks = data.queries.reduce((s, q) => s + q.clicks, 0);
    const totalImpressions = data.queries.reduce((s, q) => s + q.impressions, 0);
    const caption = usingSample
      ? "【テスト送信】週次SEOレポート（※サンプル数値のテンプレート確認版）"
      : `[info][title]週次SEOレポート (${data.period.start}〜${data.period.end})[/title]クリック数${totalClicks}件・表示回数${totalImpressions}件。詳しくは添付PDFをご確認ください。[/info]`;
    await sendChatworkFile(outPath, caption);
    console.log("Chatworkへ送信しました。");
  }
}

main().catch((err) => {
  console.error("SEOレポート生成でエラーが発生しました:", err.message);
  process.exit(1);
});
