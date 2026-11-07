// Meta広告の日別・キャンペーン別・配信面別の実績を「ZenNu 集客ダッシュボード」の データ_Meta配信面 シートに書き込むスクリプト。
//
// meta-ads-sync.mjs と同じく、データの取得は毎朝のスケジュールタスク(Claude)が Meta Ads コネクタで行う。
// ads_get_ad_entities(level=campaign, breakdowns=["publisher_platform","platform_position"], time_increment="1")
// の結果(ad_entities のJSON)をファイルに保存し、このスクリプトに渡す。
//
// 取得するフィールド: name, amount_spent, impressions, link_click, landing_page_view, results
//
// 書き込み先: データ_Meta配信面(1行 = 日付×キャンペーン×配信面)。ファイルに含まれる日付の行だけ入れ替える。
// 「配信面分析」シートが、PostHog側の データ_広告配信面 と配信面の名前で突き合わせて集計する。
//
// 実行: node scripts/meta-placement-sync.mjs <ad_entitiesのJSONファイル>

import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = path.join(os.homedir(), ".zennu-lp-secrets");
const SHEET = "データ_Meta配信面";
const HEADER = ["日付", "キャンペーン", "プラットフォーム", "配信面", "消化金額", "インプレッション", "リンクのクリック", "LPビュー", "リード", "登録完了"];

// Metaの publisher_platform / platform_position → ダッシュボードで使う名前(PostHog側の placementLabel と同じ名前にする)
const PLATFORM = { instagram: "Instagram", facebook: "Facebook", threads: "Threads", messenger: "Messenger", audience_network: "Audience Network" };
const POSITION = {
  "instagram/feed": "Instagram フィード", "instagram/instagram_stories": "Instagram ストーリーズ",
  "instagram/instagram_reels": "Instagram リール", "instagram/instagram_explore": "Instagram 発見",
  "instagram/instagram_explore_grid_home": "Instagram 発見", "instagram/instagram_profile_feed": "Instagram プロフィール",
  "facebook/feed": "Facebook フィード", "facebook/facebook_reels": "Facebook リール", "facebook/facebook_stories": "Facebook ストーリーズ",
  "threads/threads_feed": "Threads",
};

function readSecret(name) {
  return fs.readFileSync(path.join(SECRETS_DIR, name), "utf-8").trim();
}

function loadEntities(file) {
  let data = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (data && !Array.isArray(data) && data.ad_entities !== undefined) data = data.ad_entities;
  if (typeof data === "string") data = JSON.parse(data);
  if (!Array.isArray(data)) throw new Error("ad_entities の配列ではありません");
  return data;
}

const num = (v) => (v === null || v === undefined ? 0 : typeof v === "object" ? Number(v.value) || 0 : Number(v) || 0);
const resultCount = (r) => (r && Array.isArray(r.values) ? r.values.reduce((s, v) => s + (Number(v.value) || 0), 0) : 0);

function toRow(e) {
  if (!e.date_start) throw new Error(`date_start がありません(time_increment="1" で取得してください): ${e.name}`);
  if (e.publisher_platform === undefined) throw new Error(`配信面がありません(breakdowns を指定してください): ${e.name}`);
  const platform = PLATFORM[e.publisher_platform] || e.publisher_platform;
  const position = POSITION[`${e.publisher_platform}/${e.platform_position}`] || `${platform} ${e.platform_position}`;
  const indicator = e.results?.indicator || "";
  const count = resultCount(e.results);
  return [
    e.date_start, e.name || "", platform, position,
    num(e.amount_spent), num(e.impressions), num(e.link_click), num(e.landing_page_view),
    indicator.includes("fb_pixel_lead") ? count : 0,
    indicator.includes("complete_registration") ? count : 0,
  ];
}

function toIsoDate(v) {
  if (typeof v === "number") return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  return String(v || "").replace(/\//g, "-").slice(0, 10);
}

async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("使い方: node scripts/meta-placement-sync.mjs <ad_entitiesのJSONファイル>");
  // 配信面が "null" の空行や、実績がすべて0の行は入れない
  const rows = loadEntities(file)
    .filter((e) => e.publisher_platform && e.publisher_platform !== "null")
    .map(toRow)
    .filter((r) => r.slice(4).some((v) => v > 0));
  const dates = new Set(rows.map((r) => r[0]));

  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "seo-config.json"), "utf-8"));
  const { client_id, client_secret } = JSON.parse(readSecret("google-oauth-client.json"));
  const auth = new google.auth.OAuth2(client_id, client_secret);
  auth.setCredentials(JSON.parse(readSecret("google-oauth-token.json")));
  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = config.dashboardSheetId;

  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: "sheets.properties.title" });
  if (!meta.data.sheets.some((s) => s.properties.title === SHEET)) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: SHEET } } }] } });
  }
  const existing = ((await sheets.spreadsheets.values.get({ spreadsheetId, range: `${SHEET}!A2:J`, valueRenderOption: "UNFORMATTED_VALUE" })).data.values || [])
    // UNFORMATTED_VALUE だと日付はシリアル値(数値)で返るので、ファイル側と同じ YYYY-MM-DD に直してから照合する
    .map((r) => [toIsoDate(r[0]), ...r.slice(1)])
    .filter((r) => r[0] && !dates.has(r[0]));
  const merged = [...existing, ...rows].sort((a, b) => (a[0] + a[1] + a[3]).localeCompare(b[0] + b[1] + b[3]));

  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${SHEET}!A2:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId, range: `${SHEET}!A1`, valueInputOption: "USER_ENTERED", requestBody: { values: [HEADER, ...merged] },
  });
  const spend = rows.reduce((s, r) => s + r[4], 0);
  console.log(`データ_Meta配信面: ${[...dates].sort().join(", ")} の ${rows.length}行（消化 ${spend.toLocaleString()}円）`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
