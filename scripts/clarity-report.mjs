// Microsoft Clarity Data Export APIからデータを取得してレポート(PDF)を生成するスクリプト。
// 週次スケジュールタスクから実行される。見た目は scripts/report-design-kit.mjs の共通デザインキットを使用。
//
// 前提:
//   - Data Export APIトークンが ~/.zennu-lp-secrets/clarity-token.txt にある
//   - Clarityのプロジェクトを scripts/seo-config.json の clarityProjectId に設定済み
//
// API仕様上の制約:
//   - 直近3日分までしか取得できない(numOfDays=1〜3)
//   - 1プロジェクト1日10リクエストまで
//   - ヒートマップ画像・セッションリプレイ動画そのものはAPIで取得不可
//     (ダッシュボード https://clarity.microsoft.com で直接確認する必要がある)
//
// 実行: node scripts/clarity-report.mjs [出力.pdf] [--send-chatwork]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { sendChatworkFile } from "./notify-chatwork.mjs";
import { CAT, INK_MUTED, num, pct, hBarChart, kpiTile, pageHeader, card, callout, wrapDocument, renderPdfFromHtml } from "./report-design-kit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SECRETS_DIR = path.join(os.homedir(), ".zennu-lp-secrets");
const TOKEN_PATH = path.join(SECRETS_DIR, "clarity-token.txt");
const CONFIG_PATH = path.join(__dirname, "seo-config.json");

// 本番ドメイン以外(localhost・Vercelプレビュー・hacomonoウィジェット等)のノイズを除外する
const PROD_HOST = "lp.zennuwellnessdesign.jp";

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Clarity APIトークンが見つかりません: ${TOKEN_PATH}`);
  }
  return fs.readFileSync(TOKEN_PATH, "utf-8").trim();
}

function isProdUrl(url) {
  if (!url) return false;
  try {
    return new URL(url).hostname === PROD_HOST;
  } catch {
    return false;
  }
}

function metric(data, name) {
  return data.find((m) => m.metricName === name)?.information ?? [];
}

// 流入元URLはhacomonoの予約リンク等でクエリパラメータ付きの長大なURLになることがあるため、
// チャート表示用に短縮する(プロトコル除去・クエリ以降切り捨て・長すぎる場合は省略)。
function shortReferrerLabel(name) {
  let s = name.replace(/^https?:\/\//, "").split("?")[0];
  if (s.length > 42) s = `${s.slice(0, 40)}…`;
  return s;
}

const SAMPLE_DATA_PATH = path.join(__dirname, "clarity-report-data.example.json");
function loadSampleData() {
  return JSON.parse(fs.readFileSync(SAMPLE_DATA_PATH, "utf-8"));
}

export async function fetchClarityInsights(numOfDays = 3) {
  const token = loadToken();
  const res = await fetch(
    `https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=${numOfDays}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(`Clarity API取得失敗: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export function extractMetrics(data) {
  const traffic = metric(data, "Traffic")[0] ?? {};
  const engagement = metric(data, "EngagementTime")[0] ?? {};
  const scroll = metric(data, "ScrollDepth")[0] ?? {};
  const rageClick = metric(data, "RageClickCount")[0] ?? {};
  const deadClick = metric(data, "DeadClickCount")[0] ?? {};
  const quickback = metric(data, "QuickbackClick")[0] ?? {};
  const popularPages = metric(data, "PopularPages").filter((p) => isProdUrl(p.url));
  const referrers = metric(data, "ReferrerUrl").filter((r) => r.name);
  return { traffic, engagement, scroll, rageClick, deadClick, quickback, popularPages, referrers };
}

function buildInsights(m) {
  const rage = m.rageClick.sessionsWithMetricPercentage ?? 0;
  const dead = m.deadClick.sessionsWithMetricPercentage ?? 0;
  const quick = m.quickback.sessionsWithMetricPercentage ?? 0;
  const insights = [];
  if (rage >= 5) {
    insights.push({ warn: true, text: `Rage Click（同じ箇所を連打）が${pct(rage, 1)}のセッションで発生。ボタンやリンクが正しく反応していない可能性があり、該当箇所を優先的に確認したい。` });
  }
  if (dead >= 10) {
    insights.push({ warn: true, text: `Dead Click（反応しない箇所へのクリック）が${pct(dead, 1)}のセッションで発生。クリックできそうに見えて反応しない要素（装飾画像・非リンクテキスト等）がないか確認したい。` });
  }
  if (quick >= 20) {
    insights.push({ warn: true, text: `Quickback（訪問後すぐ離脱して戻る）が${pct(quick, 1)}のセッションで発生。ファーストビューの訴求とユーザーの期待にズレがある可能性がある。` });
  }
  const projectId = loadConfig().clarityProjectId;
  insights.push({
    warn: false,
    text: `ヒートマップ・セッションリプレイ動画そのものはAPI取得対象外。詳細確認はダッシュボードで: https://clarity.microsoft.com/projects/view/${projectId}`,
  });
  return insights;
}

export function buildReport(m, numOfDays, { sample = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const dateRange = `直近${numOfDays}日間（${today}時点）`;

  const uxItems = [
    { label: "Rage Click", value: m.rageClick.sessionsWithMetricPercentage ?? 0 },
    { label: "Dead Click", value: m.deadClick.sessionsWithMetricPercentage ?? 0 },
    { label: "Quickback", value: m.quickback.sessionsWithMetricPercentage ?? 0 },
  ];

  const MAX_ROWS = 6;
  const pagesItemsAll = m.popularPages.map((p) => ({
    label: p.url.replace(`https://${PROD_HOST}`, "") || "/",
    value: p.visitsCount,
  }));
  const pagesItems = pagesItemsAll.slice(0, MAX_ROWS);

  const referrerItemsAll = [...m.referrers]
    .sort((a, b) => b.sessionsCount - a.sessionsCount)
    .map((r) => ({ label: shortReferrerLabel(r.name), value: r.sessionsCount }));
  const referrerItems = referrerItemsAll.slice(0, MAX_ROWS);

  const insightsHtml = buildInsights(m)
    .map((i) => callout(i.text, { warn: i.warn }))
    .join("");

  const emptyNote = (label) => `<div style="text-align:center;color:${INK_MUTED};font-size:12px;">${label}</div>`;

  const page1 = `
    <div class="sheet">
      ${pageHeader("Clarityユーザー行動レポート", dateRange)}
      <div class="kpi-row">
        ${kpiTile({ label: "セッション数", value: num(m.traffic.totalSessionCount ?? 0) })}
        ${kpiTile({ label: "ユニークユーザー数", value: num(m.traffic.distinctUserCount ?? 0) })}
        ${kpiTile({ label: "平均スクロール深度", value: pct(m.scroll.averageScrollDepth ?? 0, 0) })}
        ${kpiTile({ label: "平均滞在時間（アクティブ時間）", value: `${num(m.engagement.totalTime ?? 0)}秒（${num(m.engagement.activeTime ?? 0)}秒）` })}
      </div>
      <div class="row-2" style="margin-bottom:14px;">
        ${card(
          "UX上の気になる挙動（発生セッション比率）",
          hBarChart(uxItems, { color: CAT.magenta, valueFmt: (v) => pct(v, 1) })
        )}
        ${card(
          `よく見られているページ（本番のみ${pagesItemsAll.length > MAX_ROWS ? `・上位${MAX_ROWS}件` : ""}）`,
          pagesItems.length ? hBarChart(pagesItems, { color: CAT.blue, valueFmt: num }) : emptyNote("該当データなし")
        )}
      </div>
      <div class="row-2">
        ${card(
          `流入経路${referrerItemsAll.length > MAX_ROWS ? `（上位${MAX_ROWS}件）` : ""}`,
          referrerItems.length ? hBarChart(referrerItems, { color: CAT.aqua, valueFmt: num }) : emptyNote("該当データなし")
        )}
        ${card("所見・次のアクション", `<div class="callout-list">${insightsHtml}</div>`)}
      </div>
    </div>`;

  return wrapDocument([page1], {
    sampleBanner: sample ? "SAMPLE — テンプレート確認用のサンプル数値です" : "",
  });
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--send-chatwork" && a !== "--sample");
  const shouldSendChatwork = process.argv.includes("--send-chatwork");
  const useSample = process.argv.includes("--sample");
  const numOfDays = 3;

  const rawData = useSample ? loadSampleData() : await fetchClarityInsights(numOfDays);
  const metrics = extractMetrics(rawData);
  const html = buildReport(metrics, numOfDays, { sample: useSample });

  const outDir = path.join(REPO_ROOT, "docs", "seo-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outPath = args[0] || path.join(outDir, `clarity-${today}.pdf`);

  await renderPdfFromHtml(html, outPath);
  console.log(`レポートを生成しました: ${outPath}`);
  if (useSample) {
    console.log("注意: --sample指定のため、サンプルデータで生成しました。");
  }

  if (shouldSendChatwork) {
    const rage = metrics.rageClick.sessionsWithMetricPercentage ?? 0;
    const dead = metrics.deadClick.sessionsWithMetricPercentage ?? 0;
    const uxNote = rage >= 5 || dead >= 10 ? "UX面で気になる挙動が検出されています。" : "";
    const caption = useSample
      ? "【テスト送信】週次Clarityレポート（※サンプル数値のテンプレート確認版）"
      : `[info][title]週次Clarityレポート (${today})[/title]セッション数${num(metrics.traffic.totalSessionCount ?? 0)}件、平均スクロール${pct(metrics.scroll.averageScrollDepth ?? 0, 0)}。${uxNote}詳しくは添付PDFをご確認ください。[/info]`;
    await sendChatworkFile(outPath, caption);
    console.log("Chatworkへ送信しました。");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("失敗:", e.message);
    process.exit(1);
  });
}
