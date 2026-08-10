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
import { CAT, INK_MUTED, num, pct, donutChart, hBarChart, lineChart, kpiTile, pageHeader, card, callout, tableHtml, wrapDocument, renderPdfFromHtml } from "./report-design-kit.mjs";

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

  const [byQuery, byPage, byDate] = await Promise.all([
    searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: { startDate: fmt(startDate), endDate: fmt(endDate), dimensions: ["query"], rowLimit: 50 },
    }),
    searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: { startDate: fmt(startDate), endDate: fmt(endDate), dimensions: ["page"], rowLimit: 50 },
    }),
    // 順位・表示回数の推移確認用(日別)。新規プロパティは日数が浅いため、
    // 実際にデータがある範囲だけ返ってくる想定。
    searchconsole.searchanalytics.query({
      siteUrl,
      requestBody: { startDate: fmt(startDate), endDate: fmt(endDate), dimensions: ["date"], rowLimit: 1000 },
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
    dailyTrend: (byDate.data.rows || [])
      .map((r) => ({
        date: r.keys[0],
        clicks: r.clicks,
        impressions: r.impressions,
        position: r.position,
      }))
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

async function fetchGA4(auth, propertyId) {
  const analyticsdata = google.analyticsdata({ version: "v1beta", auth });

  // 同じGTMコンテナがhacomonoの予約ウィジェット側ドメインにも埋め込まれているため、
  // このプロパティにはLP以外(hacomono内部ページ)のヒットも混ざる。
  // SEO用のランディングページ分析は自社ドメインだけに絞り込む。
  // (2026-08 STUDIO移行により本体はzennuwellnessdesign.jp、広告LP(cp1lp/cp2lp/cp3lp)は
  //  移行完了までlp.zennuwellnessdesign.jpと混在しうるため両方を許容する)
  // (イベント集計は絞り込まない: reserve_completeなどのCVはhacomono側ドメインで
  //  発生するため、絞り込むとコンバージョン数が正しく見えなくなる)
  const LP_HOSTNAMES = ["zennuwellnessdesign.jp", "lp.zennuwellnessdesign.jp"];

  const [landingPages, events] = await Promise.all([
    analyticsdata.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: "28daysAgo", endDate: "today" }],
        dimensions: [{ name: "landingPage" }, { name: "sessionDefaultChannelGroup" }],
        metrics: [{ name: "sessions" }, { name: "engagementRate" }, { name: "conversions" }],
        dimensionFilter: {
          filter: { fieldName: "hostName", inListFilter: { values: LP_HOSTNAMES } },
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
  const gsc = await fetchSearchConsole(auth, config.siteUrl);

  // GA4側で権限エラー等が起きても、Search Console由来の順位・表示回数データは
  // 取得できているはずなので、レポート全体を止めずGA4部分だけ空で継続する。
  let ga4 = { landingPages: [], events: [] };
  let ga4Error = null;
  try {
    ga4 = await fetchGA4(auth, config.ga4PropertyId);
  } catch (e) {
    ga4Error = e.message;
    console.error(`警告: GA4データの取得に失敗しました(SEOレポート自体は続行します): ${ga4Error}`);
  }

  const data = {
    period: gsc.period,
    siteUrl: config.siteUrl,
    queries: gsc.queries,
    pages: gsc.pages,
    dailyTrend: gsc.dailyTrend,
    landingPages: ga4.landingPages,
    events: ga4.events,
    ga4Error,
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

// 日別データを直近4週の週単位に集計する(表示回数で重み付けした平均掲載順位)。
// データが浅いプロパティでは古い週が空になるが、その場合は「データなし」として扱う。
function buildWeeklyTrend(dailyTrend) {
  if (!dailyTrend || !dailyTrend.length) return [];
  const today = new Date(dailyTrend[dailyTrend.length - 1].date);
  const weeks = [3, 2, 1, 0].map((weeksAgo) => {
    const end = new Date(today);
    end.setDate(end.getDate() - weeksAgo * 7);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const rows = dailyTrend.filter((d) => d.date >= fmt(start) && d.date <= fmt(end));
    const impressions = rows.reduce((s, r) => s + r.impressions, 0);
    const clicks = rows.reduce((s, r) => s + r.clicks, 0);
    const weightedPosition = rows.reduce((s, r) => s + r.position * r.impressions, 0);
    return {
      label: `${fmt(start).slice(5)}〜${fmt(end).slice(5)}`,
      impressions,
      clicks,
      avgPosition: impressions > 0 ? weightedPosition / impressions : null,
    };
  });
  return weeks;
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

  const weeklyTrend = buildWeeklyTrend(data.dailyTrend);
  const weeksWithData = weeklyTrend.filter((w) => w.avgPosition !== null);
  let trendVerdict;
  if (weeksWithData.length < 2) {
    trendVerdict = "まだデータの蓄積期間が短く、順位が上がっているかどうかは判断できません（新規プロパティのため、数週間分のデータが必要です）。";
  } else {
    const prev = weeksWithData[weeksWithData.length - 2];
    const latest = weeksWithData[weeksWithData.length - 1];
    const diff = prev.avgPosition - latest.avgPosition; // 正の値 = 順位改善(数字が小さくなった)
    if (Math.abs(diff) < 0.5) {
      trendVerdict = `直近週の平均掲載順位は${latest.avgPosition.toFixed(1)}位で、前週の${prev.avgPosition.toFixed(1)}位からほぼ横ばいです。`;
    } else if (diff > 0) {
      trendVerdict = `直近週の平均掲載順位は${latest.avgPosition.toFixed(1)}位で、前週の${prev.avgPosition.toFixed(1)}位より${diff.toFixed(1)}位改善（上昇）しています。`;
    } else {
      trendVerdict = `直近週の平均掲載順位は${latest.avgPosition.toFixed(1)}位で、前週の${prev.avgPosition.toFixed(1)}位より${Math.abs(diff).toFixed(1)}位下降しています。`;
    }
  }

  const trendChartValues = weeklyTrend.map((w) => w.avgPosition ?? 0);
  const trendChartLabels = weeklyTrend.map((w) => w.label);
  const trendRows = weeklyTrend.map((w) => [
    w.label,
    num(w.impressions),
    num(w.clicks),
    w.avgPosition !== null ? `${w.avgPosition.toFixed(1)}位` : "データなし",
  ]);

  const pageTrend = `
    <div class="sheet">
      ${pageHeader("掲載順位の推移（週次）", "平均掲載順位は数字が小さいほど上位（Search Console・過去28日を週単位に集計）")}
      <div class="row-2" style="margin-bottom:14px;">
        ${card(
          "週別・平均掲載順位の推移",
          weeksWithData.length ? lineChart(trendChartValues, trendChartLabels, { color: CAT.blue, valueFmt: (v) => `${v.toFixed(1)}位` }) : `<div style="text-align:center;color:${INK_MUTED};font-size:12px;">データなし</div>`
        )}
        ${card("週別実績", tableHtml(["期間", "表示回数", "クリック数", "平均掲載順位"], trendRows))}
      </div>
      ${callout(trendVerdict, { warn: false })}
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
      <div class="row-2">
        ${card("Search Console: ページ別実績", tableHtml(["ページ", "クリック数", "表示回数", "CTR", "平均掲載順位"], pageRows))}
        ${card("GA4: イベント数（過去28日）", hBarChart(eventItems, { color: CAT.aqua, valueFmt: num }))}
      </div>
    </div>`;

  // ランディングページ×流入経路の表は行数が多いと前のページと重なるため、
  // 独立したページに分ける(1ページに詰め込みすぎると.sheetの固定高さ(210mm)から
  // はみ出し、次ページのヘッダーと文字が重なる不具合になっていた)。
  const page3b = `
    <div class="sheet">
      ${pageHeader("ランディングページ×流入経路", `GA4（過去28日・セッション上位${Math.min(MAX_LANDING_ROWS, data.landingPages.length)}件）`)}
      <div class="row-2">
        ${card(
          "セッション数・エンゲージメント率・CV数",
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

  return wrapDocument([page1, pageTrend, page2, page3, page3b, page4], {
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
