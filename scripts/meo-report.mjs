// Googleビジネスプロフィールのインサイト(表示回数・検索キーワード・行動数)を
// 取得してMEOレポートを生成するスクリプト。週次スケジュールタスクから実行される。
//
// 前提:
//   - OAuthクライアント情報が ~/.zennu-lp-secrets/google-oauth-client.json にある
//   - business.manage スコープ込みでrefresh_tokenを取得済み
//     (スコープ変更後は node scripts/oauth-authorize.mjs を再実行して更新すること)
//   - scripts/meo-config.json に locationName (例: "locations/1234567890") を設定済み
//     → 未設定の場合は先に node scripts/meo-list-locations.mjs で調べる
//
// 実行: node scripts/meo-report.mjs

import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

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
  BUSINESS_IMPRESSIONS_DESKTOP_MAPS: "表示回数(PC・マップ)",
  BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: "表示回数(PC・検索)",
  BUSINESS_IMPRESSIONS_MOBILE_MAPS: "表示回数(モバイル・マップ)",
  BUSINESS_IMPRESSIONS_MOBILE_SEARCH: "表示回数(モバイル・検索)",
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

async function fetchDailyInsights(auth, locationName) {
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

async function fetchSearchKeywords(auth, locationName) {
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

function buildMarkdown({ insights, keywords, locationName }) {
  const lines = [];
  lines.push(`# MEOレポート (${insights.period.start} 〜 ${insights.period.end})`);
  lines.push("");
  lines.push(`店舗: ${locationName}`);
  lines.push("");
  lines.push("## インサイト（過去28日合計）");
  lines.push("");
  lines.push("| 指標 | 件数 |");
  lines.push("|---|---|");
  for (const metric of DAILY_METRICS) {
    lines.push(`| ${METRIC_LABELS[metric] || metric} | ${insights.totals[metric] ?? 0} |`);
  }
  lines.push("");
  lines.push(`## 検索キーワード（${keywords.yearMonth}、表示回数順）`);
  lines.push("");
  if (keywords.rows.length === 0) {
    lines.push("データなし（対象月がまだ確定していないか、件数が少なすぎる可能性があります）");
  } else {
    lines.push("| キーワード | 表示回数 |");
    lines.push("|---|---|");
    for (const row of keywords.rows.slice(0, 30)) {
      const count = row.isThreshold ? `${row.count}未満` : row.count;
      lines.push(`| ${row.keyword} | ${count} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const config = loadConfig();
  const auth = await getAuth();

  const [insights, keywords] = await Promise.all([
    fetchDailyInsights(auth, config.locationName),
    fetchSearchKeywords(auth, config.locationName),
  ]);

  const markdown = buildMarkdown({ insights, keywords, locationName: config.locationName });

  const today = new Date().toISOString().slice(0, 10);
  const outDir = path.join(REPO_ROOT, "docs", "meo-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${today}.md`);
  fs.writeFileSync(outPath, markdown, "utf-8");

  console.log(`レポートを書き出しました: ${outPath}`);
  console.log("");
  console.log(markdown);
}

main().catch((err) => {
  console.error("MEOレポート取得でエラーが発生しました:", err.message);
  process.exit(1);
});
