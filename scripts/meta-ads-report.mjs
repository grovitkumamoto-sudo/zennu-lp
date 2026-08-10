// Meta広告クリエイティブ週次レポート(A4横・2ページ)をPDFで生成するスクリプト。
// 見た目は scripts/report-design-kit.mjs の共通デザインキットを使用。
//
// このスクリプトはデータ取得・分析は行わない(週次スケジュールタスク側がMeta Ads MCPツールで
// 実データを取得し、下記スキーマのJSONを書き出してからこのスクリプトを呼ぶ)。
//
// 前提:
//   - scripts/meta-ads-report-data.json にデータを用意する
//     (未作成の場合は meta-ads-report-data.example.json のサンプル値で生成される)
//
// 実行: node scripts/meta-ads-report.mjs [出力.pdf] [--send-chatwork]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendChatworkFile } from "./notify-chatwork.mjs";
import { CAT, INK_MUTED, yen, pct, hBarChart, kpiTile, pageHeader, card, callout, tableHtml, wrapDocument, renderPdfFromHtml } from "./report-design-kit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const DATA_PATH = fs.existsSync(path.join(__dirname, "meta-ads-report-data.json"))
  ? path.join(__dirname, "meta-ads-report-data.json")
  : path.join(__dirname, "meta-ads-report-data.example.json");
const USING_SAMPLE = !fs.existsSync(path.join(__dirname, "meta-ads-report-data.json"));

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
}

function buildReport(data) {
  const creatives = data.creatives;
  const totalImpressions = creatives.reduce((s, c) => s + c.impressions, 0);
  const totalClicks = creatives.reduce((s, c) => s + c.clicks, 0);
  const totalSpend = creatives.reduce((s, c) => s + c.spend, 0);
  const totalConversions = creatives.reduce((s, c) => s + (c.conversions || 0), 0);
  const avgCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const avgCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
  const cpaText = totalConversions > 0 ? yen(totalSpend / totalConversions) : "データなし(CV0)";

  const byCtr = [...creatives].sort((a, b) => b.ctr - a.ctr);
  const byCpc = [...creatives].filter((c) => c.clicks > 0).sort((a, b) => a.cpc - b.cpc);

  const page1 = `
    <div class="sheet">
      ${pageHeader("Meta広告クリエイティブレポート", data.dateRange)}
      <div class="kpi-row">
        ${kpiTile({ label: "総表示回数", value: totalImpressions.toLocaleString("ja-JP") })}
        ${kpiTile({ label: "総クリック数", value: totalClicks.toLocaleString("ja-JP") })}
        ${kpiTile({ label: "平均CTR", value: pct(avgCtr, 2) })}
        ${kpiTile({ label: "平均CPC", value: yen(avgCpc) })}
        ${kpiTile({ label: "消化金額", value: yen(totalSpend) })}
        ${kpiTile({ label: "CPA", value: cpaText })}
      </div>
      <div class="row-2">
        ${card(
          "クリエイティブ別CTR比較（高い順）",
          hBarChart(
            byCtr.map((c) => ({ label: c.name, value: c.ctr })),
            { color: CAT.blue, valueFmt: (v) => pct(v, 2) }
          )
        )}
        ${card(
          "クリエイティブ別CPC比較（安い順）",
          byCpc.length
            ? hBarChart(
                byCpc.map((c) => ({ label: c.name, value: c.cpc })),
                { color: CAT.aqua, valueFmt: (v) => yen(v) }
              )
            : `<div style="text-align:center;color:${INK_MUTED};font-size:12px;">クリックが発生したクリエイティブがありません</div>`
        )}
      </div>
    </div>`;

  const detailRows = creatives.map((c) => [
    c.name,
    c.impressions.toLocaleString("ja-JP"),
    c.clicks.toLocaleString("ja-JP"),
    c.clicks > 0 ? pct(c.ctr, 2) : "データなし(表示のみ)",
    c.clicks > 0 ? yen(c.cpc) : "データなし(クリック0)",
    yen(c.spend),
    String(c.conversions || 0),
    c.conversions ? yen(c.spend / c.conversions) : "データなし(CV0)",
  ]);

  const insightsHtml = (data.insights || [])
    .map((text) => callout(text))
    .join("");

  const page2 = `
    <div class="sheet">
      ${pageHeader("クリエイティブ別詳細・所見", data.dateRange)}
      <div class="row-2" style="margin-bottom:14px;">
        ${card(
          "クリエイティブ別実績一覧",
          tableHtml(["クリエイティブ名/見出し", "表示回数", "クリック数", "CTR", "CPC", "消化金額", "CV数", "CPA"], detailRows)
        )}
      </div>
      <div class="card-title" style="margin-bottom:8px;">所見・次のアクション</div>
      <div class="callout-list">${insightsHtml}</div>
    </div>`;

  return wrapDocument([page1, page2], {
    sampleBanner: USING_SAMPLE ? "SAMPLE — テンプレート確認用のサンプル数値です" : "",
  });
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--send-chatwork");
  const shouldSendChatwork = process.argv.includes("--send-chatwork");

  const data = loadData();
  const html = buildReport(data);

  const outArg = args[0];
  const outDir = path.join(REPO_ROOT, "docs", "meta-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outPath = outArg || path.join(outDir, `${today}.pdf`);

  await renderPdfFromHtml(html, outPath);

  console.log(`レポートを生成しました: ${outPath}`);
  if (USING_SAMPLE) {
    console.log("注意: meta-ads-report-data.json が無いため、サンプルデータで生成しました。");
  }

  if (shouldSendChatwork) {
    const caption = USING_SAMPLE
      ? `【テスト送信】週次Meta広告クリエイティブレポート（※サンプル数値のテンプレート確認版）`
      : `[info][title]週次Meta広告クリエイティブレポート (${data.dateRange})[/title]クリエイティブ別のCTR/CPA実績と所見です。詳しくは添付PDFをご確認ください。[/info]`;
    await sendChatworkFile(outPath, caption);
    console.log("Chatworkへ送信しました。");
  }
}

main().catch((err) => {
  console.error("レポート生成でエラーが発生しました:", err.message);
  process.exit(1);
});
