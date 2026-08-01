// 月次経営レポート(A4横・5ページ)をPDFで生成するスクリプト。
// 見た目は scripts/report-design-kit.mjs の共通デザインキットを使用。
//
// 前提:
//   - scripts/monthly-report-data.json にデータを用意する
//     (未作成の場合は monthly-report-data.example.json のサンプル値で生成される)
//
// 実行: node scripts/generate-monthly-report.mjs [出力.pdf] [--send-chatwork]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendChatworkFile } from "./notify-chatwork.mjs";
import {
  CAT,
  INK,
  INK_MUTED,
  GOOD,
  CRITICAL,
  yen,
  pct,
  delta,
  donutChart,
  lineChart,
  barChart,
  funnelChart,
  kpiTile,
  pageHeader,
  card,
  wrapDocument,
  renderPdfFromHtml,
} from "./report-design-kit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const DATA_PATH = fs.existsSync(path.join(__dirname, "monthly-report-data.json"))
  ? path.join(__dirname, "monthly-report-data.json")
  : path.join(__dirname, "monthly-report-data.example.json");
const USING_SAMPLE = !fs.existsSync(path.join(__dirname, "monthly-report-data.json"));

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
}

function buildReport(data) {
  const lastIdx = data.members.length - 1;
  const prevIdx = lastIdx - 1;
  const arpu = data.revenueTotal.map((r, i) => r / data.members[i]);
  const monthLabel = `${data.reportMonth.slice(0, 4)}年${Number(data.reportMonth.slice(5, 7))}月度`;

  // ---------- Page 1: エグゼクティブサマリー ----------
  const revenueDeltaMoM = delta({ current: data.revenueTotal[lastIdx], previous: data.revenueTotal[prevIdx] });
  const revenueDeltaYoY = delta({ current: data.revenueTotal[lastIdx], previous: data.yoy.revenueTotal });
  const membersDeltaMoM = delta({ current: data.members[lastIdx], previous: data.members[prevIdx] });
  const membersDeltaYoY = delta({ current: data.members[lastIdx], previous: data.yoy.members });
  const arpuDeltaMoM = delta({ current: arpu[lastIdx], previous: arpu[prevIdx] });
  const arpuDeltaYoY = delta({ current: arpu[lastIdx], previous: data.yoy.arpu });
  const newDeltaYoY = delta({ current: data.newMembers, previous: data.yoy.newMembers });
  const churnDeltaYoY = delta({ current: data.churnMembers, previous: data.yoy.churnMembers, higherIsBetter: false });

  const membersUp = data.members[lastIdx] >= data.members[prevIdx];
  const arpuUp = arpu[lastIdx] >= arpu[prevIdx];
  const memberDiff = Math.abs(data.members[lastIdx] - data.members[prevIdx]);
  let memberChangeNote;
  if (!membersUp && arpuUp) {
    memberChangeNote = `会員数は前月比${memberDiff}名減少しましたが、ARPU(会員単価)が${arpuDeltaMoM.text}上昇したことで、総売上は前月比${revenueDeltaMoM.text}となりました。上位プランへの移行など、客単価向上が会員減少分を補っています。`;
  } else if (membersUp && !arpuUp) {
    memberChangeNote = `会員数は前月比${memberDiff}名増加した一方、ARPU(会員単価)は${arpuDeltaMoM.text}となりました。新規会員が低単価プラン中心の場合、増員ほど売上が伸びない可能性があるので構成比を確認してください。`;
  } else if (membersUp && arpuUp) {
    memberChangeNote = `会員数(${memberDiff}名増)・ARPU(${arpuDeltaMoM.text})がともに改善し、総売上は前月比${revenueDeltaMoM.text}となりました。集客とプラン単価の両輪がうまく機能しています。`;
  } else {
    memberChangeNote = `会員数(${memberDiff}名減)・ARPUともに前月から悪化しており、総売上は前月比${revenueDeltaMoM.text}です。集客数・単価の両面でのテコ入れが必要な状況です。`;
  }

  const page1 = `
    <div class="sheet">
      ${pageHeader("エグゼクティブサマリー", monthLabel)}
      <div class="kpi-row">
        ${kpiTile({ label: "総売上", value: yen(data.revenueTotal[lastIdx]), deltas: [{ label: "前月比", ...revenueDeltaMoM }, { label: "前年同月比", ...revenueDeltaYoY }] })}
        ${kpiTile({ label: "アクティブ会員数", value: `${data.members[lastIdx]}名`, deltas: [{ label: "前月比", ...membersDeltaMoM }, { label: "前年同月比", ...membersDeltaYoY }] })}
        ${kpiTile({ label: "ARPU(会員単価)", value: yen(arpu[lastIdx]), deltas: [{ label: "前月比", ...arpuDeltaMoM }, { label: "前年同月比", ...arpuDeltaYoY }] })}
        ${kpiTile({ label: "新規入会数", value: `${data.newMembers}件`, deltas: [{ label: "前年同月比", ...newDeltaYoY }] })}
        ${kpiTile({ label: "解約数", value: `${data.churnMembers}件`, deltas: [{ label: "前年同月比", ...churnDeltaYoY }] })}
      </div>
      <div class="callout">
        <span class="callout-icon">💡</span>
        <span>${memberChangeNote}</span>
      </div>
      <div class="row-2">
        ${card("会員数推移（過去6ヶ月）", lineChart(data.members, data.monthLabels, { color: CAT.blue, valueFmt: (v) => `${v}名` }))}
        ${card("総売上推移（過去6ヶ月）", barChart(data.revenueTotal, data.monthLabels, { color: CAT.blue, valueFmt: (v) => yen(v).replace("¥", "") }))}
      </div>
    </div>`;

  // ---------- Page 2: 集客・広告 ----------
  const adSpendMoM = delta({ current: data.ad.spend[lastIdx], previous: data.ad.spend[prevIdx], higherIsBetter: false });
  const cpaSeries = data.ad.spend.map((s, i) => s / data.ad.inquiries[i]);
  const cpaMoM = delta({ current: cpaSeries[lastIdx], previous: cpaSeries[prevIdx], higherIsBetter: false });
  const cpaYoY = delta({ current: cpaSeries[lastIdx], previous: data.ad.spendYoyPrev / data.ad.inquiriesYoyPrev, higherIsBetter: false });
  const inquiriesYoY = delta({ current: data.ad.inquiries[lastIdx], previous: data.ad.inquiriesYoyPrev });
  const ctrYoY = delta({ current: data.ad.ctr, previous: data.ad.ctrYoyPrev, unit: "pt" });

  const page2 = `
    <div class="sheet">
      ${pageHeader("集客・広告", monthLabel)}
      <div class="kpi-row">
        ${kpiTile({ label: "広告費", value: yen(data.ad.spend[lastIdx]), deltas: [{ label: "前月比", ...adSpendMoM, cls: "flat" }] })}
        ${kpiTile({ label: "問い合わせ数", value: `${data.ad.inquiries[lastIdx]}件`, deltas: [{ label: "前年同月比", ...inquiriesYoY }] })}
        ${kpiTile({ label: "CPA(1件あたり獲得コスト)", value: yen(cpaSeries[lastIdx]), deltas: [{ label: "前月比", ...cpaMoM }, { label: "前年同月比", ...cpaYoY }] })}
        ${kpiTile({ label: "CTR", value: pct(data.ad.ctr), deltas: [{ label: "前年同月比", ...ctrYoY }] })}
      </div>
      <div class="row-2">
        ${card("広告費・問い合わせ数の推移（過去6ヶ月）", `<div class="row-2-inner">${lineChart(data.ad.spend, data.monthLabels, { width: 230, color: CAT.blue, valueFmt: (v) => yen(v).replace("¥", "") })}${lineChart(data.ad.inquiries, data.monthLabels, { width: 230, color: CAT.aqua, valueFmt: (v) => `${v}件` })}</div>`)}
        ${card("問い合わせチャネル別内訳（当月）", donutChart(data.ad.channelBreakdown, [CAT.blue, CAT.aqua, CAT.yellow, CAT.magenta]))}
      </div>
    </div>`;

  // ---------- Page 3: 新規対応(ファネル) ----------
  const visitRate = (data.funnel.visits[lastIdx] / data.funnel.inquiries[lastIdx]) * 100;
  const signupRate = (data.funnel.signups[lastIdx] / data.funnel.visits[lastIdx]) * 100;
  const visitRateYoY = delta({ current: visitRate, previous: data.yoy.visitRate, unit: "pt" });
  const signupRateYoY = delta({ current: signupRate, previous: data.yoy.signupRate, unit: "pt" });

  const tableRows = data.funnel.months
    .map((m, i) => {
      const vr = (data.funnel.visits[i] / data.funnel.inquiries[i]) * 100;
      const sr = (data.funnel.signups[i] / data.funnel.visits[i]) * 100;
      return `<tr><td>${m}</td><td>${data.funnel.inquiries[i]}</td><td>${data.funnel.visits[i]}</td><td>${pct(vr, 0)}</td><td>${data.funnel.signups[i]}</td><td>${pct(sr, 0)}</td></tr>`;
    })
    .join("");

  const page3 = `
    <div class="sheet">
      ${pageHeader("新規対応（ファネル）", monthLabel)}
      <div class="kpi-row">
        ${kpiTile({ label: "問い合わせ数", value: `${data.funnel.inquiries[lastIdx]}件` })}
        ${kpiTile({ label: "来店数", value: `${data.funnel.visits[lastIdx]}件` })}
        ${kpiTile({ label: "来店率", value: pct(visitRate, 0), deltas: [{ label: "前年同月比", ...visitRateYoY }] })}
        ${kpiTile({ label: "入会数", value: `${data.funnel.signups[lastIdx]}件` })}
        ${kpiTile({ label: "入会率", value: pct(signupRate, 0), deltas: [{ label: "前年同月比", ...signupRateYoY }] })}
      </div>
      <div class="row-2">
        ${card(
          "会員獲得ファネル（当月）",
          funnelChart([
            { label: "問い合わせ", value: data.funnel.inquiries[lastIdx] },
            { label: "来店", value: data.funnel.visits[lastIdx] },
            { label: "入会", value: data.funnel.signups[lastIdx] },
          ])
        )}
        ${card(
          "月次比較（過去6ヶ月）",
          `<table class="tbl"><thead><tr><th>月</th><th>問い合わせ数</th><th>来店数</th><th>来店率</th><th>入会数</th><th>入会率</th></tr></thead><tbody>${tableRows}</tbody></table>`
        )}
      </div>
    </div>`;

  // ---------- Page 4: 売上分解(ARPU分析) ----------
  const ticketMoM = delta({ current: data.ticketRevenue[lastIdx], previous: data.ticketRevenue[prevIdx] });
  const arpuYoY2 = delta({ current: arpu[lastIdx], previous: data.yoy.arpu });
  const planColors = [CAT.blue, CAT.aqua, CAT.yellow, CAT.magenta];

  const page4 = `
    <div class="sheet">
      ${pageHeader("売上分解（ARPU分析）", monthLabel)}
      <div class="formula">
        <span class="f-box">総売上 ${yen(data.revenueTotal[lastIdx])}</span>
        <span class="f-eq">=</span>
        <span class="f-box">会員数 ${data.members[lastIdx]}名</span>
        <span class="f-eq">×</span>
        <span class="f-box">ARPU ${yen(arpu[lastIdx])} <span class="f-delta ${arpuYoY2.cls}">(前年同月比 ${arpuYoY2.text})</span></span>
      </div>
      <div class="callout warn">
        <span class="callout-icon">⚠️</span>
        <span>回数券売上は前月比${ticketMoM.text}で、6ヶ月連続で減少傾向にあります。プラン移行（月額制への切り替え）が進んでいる可能性があります。</span>
      </div>
      <div class="row-2">
        ${card("プラン別売上構成比（当月）", donutChart(data.plans.map((p) => ({ label: p.label, value: p.revenue })), planColors))}
        ${card("回数券売上の推移（過去6ヶ月）", lineChart(data.ticketRevenue, data.monthLabels, { color: CAT.magenta, valueFmt: (v) => yen(v).replace("¥", "") }))}
      </div>
    </div>`;

  // ---------- Page 5: 会員動態 ----------
  const cohort3Delta = delta({ current: data.yoy.cohort3m, previous: data.yoy.cohort3m - 4, unit: "pt" });
  const capacityPct = (data.capacity.selfCurrent / data.capacity.selfMax) * 100;

  const bridgeStart = data.members[prevIdx];
  const bridgeEnd = data.members[lastIdx];
  const bridgeMax = Math.max(bridgeStart, bridgeEnd) + data.newMembers + 4;
  const bw = 460 / 4;
  const by = (v) => 130 - (v / bridgeMax) * 110;
  const bridgeSvg = `<svg viewBox="0 0 460 160" width="100%" height="160">
      <rect x="10" y="${by(bridgeStart)}" width="${bw - 10}" height="${130 - by(bridgeStart)}" rx="3" fill="${CAT.blue}"/>
      <text x="${10 + (bw - 10) / 2}" y="${by(bridgeStart) - 8}" font-size="12" text-anchor="middle" fill="${INK}">${bridgeStart}名</text>
      <text x="${10 + (bw - 10) / 2}" y="148" font-size="11" text-anchor="middle" fill="${INK_MUTED}">前月末</text>
      <rect x="${bw + 10}" y="${by(bridgeStart + data.newMembers)}" width="${bw - 10}" height="${by(bridgeStart) - by(bridgeStart + data.newMembers)}" rx="3" fill="${GOOD}"/>
      <text x="${bw + 10 + (bw - 10) / 2}" y="${by(bridgeStart + data.newMembers) - 8}" font-size="12" text-anchor="middle" fill="${INK}">+${data.newMembers}</text>
      <text x="${bw + 10 + (bw - 10) / 2}" y="148" font-size="11" text-anchor="middle" fill="${INK_MUTED}">新規入会</text>
      <rect x="${bw * 2 + 10}" y="${by(bridgeStart + data.newMembers)}" width="${bw - 10}" height="${130 - by(bridgeStart + data.newMembers) - (130 - by(bridgeEnd))}" rx="3" fill="${CRITICAL}"/>
      <text x="${bw * 2 + 10 + (bw - 10) / 2}" y="${by(bridgeStart + data.newMembers) - 8}" font-size="12" text-anchor="middle" fill="${INK}">−${data.churnMembers}</text>
      <text x="${bw * 2 + 10 + (bw - 10) / 2}" y="148" font-size="11" text-anchor="middle" fill="${INK_MUTED}">解約</text>
      <rect x="${bw * 3 + 10}" y="${by(bridgeEnd)}" width="${bw - 10}" height="${130 - by(bridgeEnd)}" rx="3" fill="${CAT.blue}"/>
      <text x="${bw * 3 + 10 + (bw - 10) / 2}" y="${by(bridgeEnd) - 8}" font-size="12" text-anchor="middle" fill="${INK}">${bridgeEnd}名</text>
      <text x="${bw * 3 + 10 + (bw - 10) / 2}" y="148" font-size="11" text-anchor="middle" fill="${INK_MUTED}">当月末</text>
    </svg>`;

  const churnColors = [CAT.blue, CAT.aqua];

  const page5 = `
    <div class="sheet">
      ${pageHeader("会員動態", monthLabel)}
      <div class="kpi-row">
        ${kpiTile({ label: "3ヶ月継続率", value: pct(data.yoy.cohort3m, 0), deltas: [{ label: "前年同月比", ...cohort3Delta }] })}
        ${kpiTile({ label: "セルフ利用キャパシティ", value: `${data.capacity.selfCurrent} / ${data.capacity.selfMax}名`, deltas: [{ label: "使用率", text: pct(capacityPct, 0), cls: "flat" }] })}
      </div>
      <div class="row-2">
        ${card("会員数の増減内訳（当月）", bridgeSvg)}
        ${card("解約理由の内訳（当月）", donutChart(data.churnReasons, churnColors))}
      </div>
    </div>`;

  return wrapDocument([page1, page2, page3, page4, page5], {
    sampleBanner: USING_SAMPLE ? "SAMPLE — テンプレート確認用のサンプル数値です" : "",
  });
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--send-chatwork");
  const shouldSendChatwork = process.argv.includes("--send-chatwork");

  const data = loadData();
  const html = buildReport(data);

  const outArg = args[0];
  const outDir = path.join(REPO_ROOT, "docs", "monthly-reports");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = outArg || path.join(outDir, `${data.reportMonth}.pdf`);

  await renderPdfFromHtml(html, outPath);

  console.log(`レポートを生成しました: ${outPath}`);
  if (USING_SAMPLE) {
    console.log("注意: monthly-report-data.json が無いため、サンプルデータで生成しました。");
  }

  if (shouldSendChatwork) {
    const monthLabel = `${data.reportMonth.slice(0, 4)}年${Number(data.reportMonth.slice(5, 7))}月度`;
    const caption = USING_SAMPLE
      ? `【テスト送信】${monthLabel} 月次経営レポート（※サンプル数値のテンプレート確認版）`
      : `${monthLabel} 月次経営レポートができました。`;
    await sendChatworkFile(outPath, caption);
    console.log("Chatworkへ送信しました。");
  }
}

main().catch((err) => {
  console.error("レポート生成でエラーが発生しました:", err.message);
  process.exit(1);
});
