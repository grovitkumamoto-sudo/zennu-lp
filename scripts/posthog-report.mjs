// PostHog(HogQL Query API)からCTAクリック・ページ実績を取得してレポート(PDF)を生成するスクリプト。
// 見た目は scripts/report-design-kit.mjs の共通デザインキットを使用。
//
// 前提:
//   - Personal API Key(phx_...)が ~/.zennu-lp-secrets/posthog-personal-api-key.txt にある
//   - PostHogのプロジェクトIDを scripts/seo-config.json の posthogProjectId に設定済み
//
// 実行: node scripts/posthog-report.mjs [出力.pdf] [--send-chatwork] [--sample]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { sendChatworkFile } from "./notify-chatwork.mjs";
import { CAT, INK_MUTED, num, pct, hBarChart, lineChart, kpiTile, pageHeader, card, callout, tableHtml, wrapDocument, renderPdfFromHtml } from "./report-design-kit.mjs";
import { appendHistory, loadHistory } from "./report-history.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const SECRETS_DIR = path.join(os.homedir(), ".zennu-lp-secrets");
const TOKEN_PATH = path.join(SECRETS_DIR, "posthog-personal-api-key.txt");
const CONFIG_PATH = path.join(__dirname, "seo-config.json");
const SAMPLE_DATA_PATH = path.join(__dirname, "posthog-report-data.example.json");

const API_HOST = "https://us.posthog.com";
const DAYS = 14;

// 本番ドメイン以外(hacomonoの予約ウィジェット・localhost・Vercelプレビュー等)を除外する。
// 同じGTMコンテナがhacomono側にも入っているため、フィルタしないとLP以外のクリックが混ざる。
const PROD_HOSTS = new Set(["zennuwellnessdesign.jp", "lp.zennuwellnessdesign.jp"]);

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`PostHog Personal API Keyが見つかりません: ${TOKEN_PATH}`);
  }
  return fs.readFileSync(TOKEN_PATH, "utf-8").trim();
}

function isProdUrl(url) {
  if (!url) return false;
  try {
    return PROD_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function pathOf(url) {
  if (!url) return "(不明)";
  try {
    const u = new URL(url);
    return u.pathname || "/";
  } catch {
    return url;
  }
}

async function hogql(token, projectId, query) {
  const res = await fetch(`${API_HOST}/api/projects/${projectId}/query/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
  });
  const data = await res.json();
  if (!res.ok || data.error) {
    throw new Error(`PostHog Query API失敗: ${res.status} ${JSON.stringify(data)}`);
  }
  return data.results || [];
}

export async function fetchPostHogInsights() {
  const token = loadToken();
  const config = loadConfig();
  const projectId = config.posthogProjectId;
  if (!projectId) {
    throw new Error("scripts/seo-config.json に posthogProjectId が設定されていません");
  }

  // ドメイン絞り込みのLIKE条件(本番ドメインのみ。hacomonoウィジェット等を除外)
  const domainFilter = [...PROD_HOSTS].map((h) => `properties.$current_url like 'https://${h}%'`).join(" or ");

  const [eventCounts, clickRows, pageviewRows] = await Promise.all([
    // イベント種別ごとの件数(サーバー側で集計。URL単位でgroupすると行数上限に
    // 引っかかりautocapture等の件数が正しく取れなかったため、event単位のみで集計する)
    hogql(
      token,
      projectId,
      `select event, count() as c
       from events
       where timestamp > now() - interval ${DAYS} day and event in ('$pageview','$autocapture','$pageleave')
       and (${domainFilter})
       group by event`
    ),
    // クリック要素の内訳(テキスト・URL別)。上限行数に達する前に本番ドメインへ絞り込む。
    // 同一人物の連打で件数が水増しされないよう、クリック数とは別にユニークユーザー数も取得する。
    hogql(
      token,
      projectId,
      `select properties.$el_text as text, properties.$current_url as url, count() as c, count(distinct distinct_id) as u
       from events
       where event = '$autocapture' and timestamp > now() - interval ${DAYS} day
       and (${domainFilter})
       group by text, url
       order by c desc
       limit 200`
    ),
    // ページ別のpageview数。同様に本番ドメインへ絞り込む。
    hogql(
      token,
      projectId,
      `select properties.$current_url as url, count() as c
       from events
       where event = '$pageview' and timestamp > now() - interval ${DAYS} day
       and (${domainFilter})
       group by url
       order by c desc
       limit 200`
    ),
  ]);

  return { eventCounts, clickRows, pageviewRows };
}

export function buildSummary({ eventCounts }) {
  const totals = { pageview: 0, autocapture: 0, pageleave: 0 };
  for (const [event, c] of eventCounts) {
    if (event === "$pageview") totals.pageview += c;
    else if (event === "$autocapture") totals.autocapture += c;
    else if (event === "$pageleave") totals.pageleave += c;
  }
  return totals;
}

// クリック数(c)とは別にユニークユーザー数(u)も保持する。
// 単純にラベル単位で合算するとuを正しく合算できない(同一ユーザーが複数行にまたがる場合の
// 重複カウント)ため、ここでは同名要素×同URLの組は元々HogQL側でgroup済みなのでそのまま使う。
export function buildClickItems(clickRows, { max = 10 } = {}) {
  const rows = clickRows
    .filter(([, url]) => isProdUrl(url))
    .map(([text, url, c, u]) => ({
      label: `${text ? text.slice(0, 24) : "(テキストなし)"} — ${pathOf(url)}`,
      clicks: c,
      uniqueUsers: u ?? null,
    }))
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, max);
  return rows;
}

export function buildPageItems(pageviewRows, { max = 10 } = {}) {
  const merged = new Map();
  for (const [url, c] of pageviewRows) {
    if (!isProdUrl(url)) continue;
    const p = pathOf(url);
    merged.set(p, (merged.get(p) || 0) + c);
  }
  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([label, value]) => ({ label, value }));
}

function loadSampleData() {
  return JSON.parse(fs.readFileSync(SAMPLE_DATA_PATH, "utf-8"));
}

// PostHogは直近${DAYS}日間のスナップショットしか一度に見せられないため、レポート実行のたびに
// 1点記録し、蓄積したぶんだけ推移グラフにする(Clarity/Meta広告レポートと同じ仕組み)。
function buildTrendPage(history) {
  if (history.length < 2) {
    return `
    <div class="sheet">
      ${pageHeader("推移グラフ（蓄積中）", "週次スナップショットを記録し、蓄積したぶんだけ表示します")}
      ${callout(
        `このレポートを実行するたびに1週間分のスナップショットを記録しており、今回で${history.length}件目です。数週間分たまり次第、ここに推移グラフが表示されます。`,
        { warn: false }
      )}
    </div>`;
  }
  const labels = history.map((h) => h.date.slice(5));
  const pageviewChart = lineChart(history.map((h) => h.pageview ?? 0), labels, { color: CAT.blue, valueFmt: num });
  const clickChart = lineChart(history.map((h) => h.autocapture ?? 0), labels, { color: CAT.aqua, valueFmt: num });

  return `
    <div class="sheet">
      ${pageHeader("推移グラフ（週次スナップショット）", `直近${history.length}回の実行分を記録`)}
      <div class="row-2">
        ${card("ページビュー数の推移", pageviewChart)}
        ${card("クリック等の操作数の推移", clickChart)}
      </div>
    </div>`;
}

export function buildReport(raw, { sample = false, history = [] } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const summary = buildSummary(raw);
  const clickItems = buildClickItems(raw.clickRows, { max: 8 });
  const pageItems = buildPageItems(raw.pageviewRows, { max: 8 });

  const emptyNote = (label) => `<div style="text-align:center;color:${INK_MUTED};font-size:12px;">${label}</div>`;

  const page1 = `
    <div class="sheet">
      ${pageHeader("PostHogユーザー行動レポート", `直近${DAYS}日間（${today}時点・本番ドメインのみ）`)}
      <div class="kpi-row">
        ${kpiTile({ label: "ページビュー数", value: num(summary.pageview) })}
        ${kpiTile({ label: "クリック等の操作数", value: num(summary.autocapture) })}
        ${kpiTile({ label: "離脱イベント数", value: num(summary.pageleave) })}
      </div>
      <div class="row-2" style="flex:0 0 auto;">
        ${card(
          `よくクリックされている要素（上位${clickItems.length}件・クリック数順）`,
          clickItems.length
            ? tableHtml(
                ["要素", "クリック数", "ユニークユーザー数"],
                clickItems.map((i) => [i.label, num(i.clicks), i.uniqueUsers != null ? num(i.uniqueUsers) : "-"])
              )
            : emptyNote("該当データなし")
        )}
        ${card(
          `よく見られているページ（上位${pageItems.length}件）`,
          pageItems.length ? hBarChart(pageItems, { color: CAT.blue, valueFmt: num }) : emptyNote("該当データなし")
        )}
      </div>
      ${callout(
        "クリック数が多くてもユニークユーザー数が少ない場合、同一の訪問者が連打・連続操作している可能性が高い(1人が何度もカルーセルを送った等)。判断には両方の数字を確認したい。"
      )}
      ${callout(
        "スクロール深度・離脱ポイントの詳細分析はPostHogのHeatmaps/Session Replay機能でダッシュボード上から直接確認してください: https://us.posthog.com/project/" +
          (loadConfig().posthogProjectId || "") +
          "/session-recordings"
      )}
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

  const raw = useSample ? loadSampleData() : await fetchPostHogInsights();

  let history = loadHistory("posthog");
  if (!useSample) {
    const summary = buildSummary(raw);
    history = appendHistory("posthog", { date: today, ...summary });
  }

  const html = buildReport(raw, { sample: useSample, history });

  const outDir = path.join(REPO_ROOT, "docs", "seo-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = args[0] || path.join(outDir, `posthog-${today}.pdf`);

  await renderPdfFromHtml(html, outPath);
  console.log(`レポートを生成しました: ${outPath}`);

  if (shouldSendChatwork) {
    const summary = buildSummary(raw);
    const caption = useSample
      ? "【テスト送信】週次PostHogレポート（※サンプル数値のテンプレート確認版）"
      : `[info][title]週次PostHogレポート (${today})[/title]直近${DAYS}日間: ページビュー${summary.pageview}件・操作${summary.autocapture}件。詳しくは添付PDFをご確認ください。[/info]`;
    await sendChatworkFile(outPath, caption);
    console.log("Chatworkへ送信しました。");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("PostHogレポート生成でエラーが発生しました:", err.message);
    process.exit(1);
  });
}
