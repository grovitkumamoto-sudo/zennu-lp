// Googleビジネスプロフィール(MEO)のインサイト(表示回数・検索キーワード・行動数)を
// 取得してレポート(PDF)を生成するスクリプト。週次スケジュールタスクから実行される。
// 見た目は scripts/report-design-kit.mjs の共通デザインキットを使用。
//
// 前提:
//   - OAuthクライアント情報が ~/.zennu-lp-secrets/google-oauth-client.json にある
//   - business.manage スコープ込みでrefresh_tokenを取得済み
//     (スコープ変更後は node scripts/oauth-authorize.mjs を再実行して更新すること)
//   - scripts/meo-config.json に locationName (例: "locations/1234567890") を設定済み
//     → 未設定の場合は先に node scripts/meo-list-locations.mjs で調べる
//
// 実行: node scripts/meo-report.mjs [出力.pdf] [--send-chatwork]

import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { sendChatworkFile } from "./notify-chatwork.mjs";
import { CAT, INK_MUTED, num, hBarChart, lineChart, kpiTile, pageHeader, card, callout, tableHtml, wrapDocument, renderPdfFromHtml } from "./report-design-kit.mjs";
import { appendHistory, loadHistory } from "./report-history.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const SECRETS_DIR = path.join(os.homedir(), ".zennu-lp-secrets");
const CLIENT_PATH = path.join(SECRETS_DIR, "google-oauth-client.json");
const TOKEN_PATH = path.join(SECRETS_DIR, "google-oauth-token.json");
const CONFIG_PATH = path.join(__dirname, "meo-config.json");

const DAILY_METRICS = [
  "BUSINESS_IMPRESSIONS_DESKTOP_MAPS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
  "BUSINESS_IMPRESSIONS_MOBILE_MAPS",
  "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
  "BUSINESS_CONVERSATIONS",
  "BUSINESS_DIRECTION_REQUESTS",
  "CALL_CLICKS",
  "WEBSITE_CLICKS",
];

const METRIC_LABELS = {
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "PC・マップ",
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "PC・検索",
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: "モバイル・マップ",
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "モバイル・検索",
  BUSINESS_CONVERSATIONS: "メッセージ数",
  BUSINESS_DIRECTION_REQUESTS: "ルート検索数",
  CALL_CLICKS: "電話タップ数",
  WEBSITE_CLICKS: "ウェブサイトクリック数",
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `設定ファイルが見つかりません: ${CONFIG_PATH}\n` +
        `scripts/meo-config.example.json をコピーして locationName を設定してください。\n` +
        `locationNameが分からない場合は node scripts/meo-list-locations.mjs で調べられます。`
    );
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

function toDateParts(d) {
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

export async function fetchDailyInsights(auth, locationName) {
  const api = google.businessprofileperformance({ version: "v1", auth });

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(endDate.getDate() - 28);

  const { data } = await api.locations.fetchMultiDailyMetricsTimeSeries({
    location: locationName,
    dailyMetrics: DAILY_METRICS,
    "dailyRange.startDate.year": toDateParts(startDate).year,
    "dailyRange.startDate.month": toDateParts(startDate).month,
    "dailyRange.startDate.day": toDateParts(startDate).day,
    "dailyRange.endDate.year": toDateParts(endDate).year,
    "dailyRange.endDate.month": toDateParts(endDate).month,
    "dailyRange.endDate.day": toDateParts(endDate).day,
  });

  const totals = {};
  for (const entry of data.multiDailyMetricTimeSeries || []) {
    for (const series of entry.dailyMetricTimeSeries || []) {
      const metric = series.dailyMetric;
      const values = series.timeSeries?.datedValues || [];
      totals[metric] = values.reduce((sum, v) => sum + Number(v.value || 0), 0);
    }
  }

  return {
    period: { start: startDate.toISOString().slice(0, 10), end: endDate.toISOString().slice(0, 10) },
    totals,
  };
}

export async function fetchSearchKeywords(auth, locationName) {
  const api = google.businessprofileperformance({ version: "v1", auth });

  // 検索キーワードは月次集計のみ提供される。直近の確定済み月(先月)を対象にする。
  const now = new Date();
  const target = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const y = target.getFullYear();
  const m = target.getMonth() + 1;

  const { data } = await api.locations.searchkeywords.impressions.monthly.list({
    parent: locationName,
    "monthlyRange.startMonth.year": y,
    "monthlyRange.startMonth.month": m,
    "monthlyRange.endMonth.year": y,
    "monthlyRange.endMonth.month": m,
    pageSize: 100,
  });

  const rows = (data.searchKeywordsCounts || [])
    .map((row) => ({
      keyword: row.searchKeyword,
      count: Number(row.insightsValue?.value ?? row.insightsValue?.threshold ?? 0),
      isThreshold: row.insightsValue?.threshold !== undefined,
    }))
    .sort((a, b) => b.count - a.count);

  return { yearMonth: `${y}-${String(m).padStart(2, "0")}`, rows };
}

const SAMPLE_DATA_PATH = path.join(__dirname, "meo-report-data.example.json");
function loadSampleData() {
  return JSON.parse(fs.readFileSync(SAMPLE_DATA_PATH, "utf-8"));
}

function buildTrendPage(history) {
  if (history.length < 2) {
    return `
    <div class="sheet">
      ${pageHeader("推移グラフ（蓄積中）", "週次スナップショットを記録し、蓄積したぶんだけ表示します")}
      ${callout(
        `このレポートを実行するたびに1回分のスナップショットを記録しており、今回で${history.length}件目です。数週間分たまり次第、ここに推移グラフが表示されます。`,
        { warn: false }
      )}
    </div>`;
  }
  const labels = history.map((h) => h.date.slice(5));
  const impressionsChart = lineChart(history.map((h) => h.totalImpressions ?? 0), labels, { color: CAT.blue, valueFmt: num });
  const websiteChart = lineChart(history.map((h) => h.websiteClicks ?? 0), labels, { color: CAT.aqua, valueFmt: num });
  const callChart = lineChart(history.map((h) => h.callClicks ?? 0), labels, { color: CAT.magenta, valueFmt: num });
  const directionChart = lineChart(history.map((h) => h.directionRequests ?? 0), labels, { color: CAT.yellow, valueFmt: num });

  return `
    <div class="sheet">
      ${pageHeader("推移グラフ（週次スナップショット）", `直近${history.length}回の実行分を記録（過去28日合計値の推移）`)}
      <div class="row-2" style="margin-bottom:14px;">
        ${card("総表示回数の推移", impressionsChart)}
        ${card("ウェブサイトクリック数の推移", websiteChart)}
      </div>
      <div class="row-2">
        ${card("電話タップ数の推移", callChart)}
        ${card("ルート検索数の推移", directionChart)}
      </div>
    </div>`;
}

function buildReport({ insights, keywords, locationLabel }, { sample = false, history = [] } = {}) {
  const totals = insights.totals;
  const totalImpressions = DAILY_METRICS.filter((m) => m.startsWith("BUSINESS_IMPRESSIONS")).reduce((s, m) => s + (totals[m] || 0), 0);

  const impressionItems = DAILY_METRICS.filter((m) => m.startsWith("BUSINESS_IMPRESSIONS")).map((m) => ({
    label: METRIC_LABELS[m],
    value: totals[m] || 0,
  }));

  const emptyNote = (label) => `<div style="text-align:center;color:${INK_MUTED};font-size:12px;">${label}</div>`;

  const page1 = `
    <div class="sheet">
      ${pageHeader("MEOレポート（Googleビジネスプロフィール）", `${insights.period.start}〜${insights.period.end}・${locationLabel}`)}
      <div class="kpi-row">
        ${kpiTile({ label: "総表示回数", value: num(totalImpressions) })}
        ${kpiTile({ label: "ウェブサイトクリック数", value: num(totals.WEBSITE_CLICKS || 0) })}
        ${kpiTile({ label: "電話タップ数", value: num(totals.CALL_CLICKS || 0) })}
        ${kpiTile({ label: "ルート検索数", value: num(totals.BUSINESS_DIRECTION_REQUESTS || 0) })}
        ${kpiTile({ label: "メッセージ数", value: num(totals.BUSINESS_CONVERSATIONS || 0) })}
      </div>
      <div class="row-2">
        ${card("表示回数の内訳（PC/モバイル × マップ/検索）", hBarChart(impressionItems, { color: CAT.blue, valueFmt: num }))}
        ${card(
          `検索キーワード上位（${keywords.yearMonth}）`,
          keywords.rows.length
            ? tableHtml(
                ["キーワード", "表示回数"],
                keywords.rows.slice(0, 10).map((r) => [r.keyword, r.isThreshold ? `${r.count}未満` : num(r.count)])
              )
            : emptyNote("データなし（対象月の確定待ち、または件数が少なすぎる可能性があります）")
        )}
      </div>
    </div>`;

  const pageTrend = buildTrendPage(history);

  return wrapDocument([page1, pageTrend], {
    sampleBanner: sample ? "SAMPLE — テンプレート確認用のサンプル数値です" : "",
  });
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--send-chatwork" && a !== "--sample");
  const shouldSendChatwork = process.argv.includes("--send-chatwork");
  const useSample = process.argv.includes("--sample");
  const today = new Date().toISOString().slice(0, 10);

  let data;
  if (useSample) {
    data = loadSampleData();
  } else {
    const config = loadConfig();
    const auth = await getAuth();
    const [insights, keywords] = await Promise.all([
      fetchDailyInsights(auth, config.locationName),
      fetchSearchKeywords(auth, config.locationName),
    ]);
    data = { insights, keywords, locationLabel: config.locationName };
  }

  let history = loadHistory("meo");
  if (!useSample) {
    const totals = data.insights.totals;
    const totalImpressions = DAILY_METRICS.filter((m) => m.startsWith("BUSINESS_IMPRESSIONS")).reduce((s, m) => s + (totals[m] || 0), 0);
    history = appendHistory("meo", {
      date: today,
      totalImpressions,
      websiteClicks: totals.WEBSITE_CLICKS || 0,
      callClicks: totals.CALL_CLICKS || 0,
      directionRequests: totals.BUSINESS_DIRECTION_REQUESTS || 0,
      conversations: totals.BUSINESS_CONVERSATIONS || 0,
    });
  }

  const html = buildReport(data, { sample: useSample, history });

  const outDir = path.join(REPO_ROOT, "docs", "meo-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = args[0] || path.join(outDir, `${today}.pdf`);

  await renderPdfFromHtml(html, outPath);
  console.log(`レポートを生成しました: ${outPath}`);
  if (useSample) {
    console.log("注意: --sample指定のため、サンプルデータで生成しました。");
  }

  if (shouldSendChatwork) {
    const totals = data.insights.totals;
    const totalImpressions = DAILY_METRICS.filter((m) => m.startsWith("BUSINESS_IMPRESSIONS")).reduce((s, m) => s + (totals[m] || 0), 0);
    const caption = useSample
      ? "【テスト送信】週次MEOレポート（※サンプル数値のテンプレート確認版）"
      : `[info][title]週次MEOレポート (${today})[/title]過去28日間: 表示回数${num(totalImpressions)}件・ウェブサイトクリック${num(totals.WEBSITE_CLICKS || 0)}件。詳しくは添付PDFをご確認ください。[/info]`;
    await sendChatworkFile(outPath, caption);
    console.log("Chatworkへ送信しました。");
  }
}

main().catch((err) => {
  console.error("MEOレポート生成でエラーが発生しました:", err.message);
  process.exit(1);
});
