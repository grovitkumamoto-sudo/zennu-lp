// ZenNu WELLNESS DESIGN 定例レポート共通デザインキット。
// A4横・カード型KPI・SVGチャートのレポートPDFを作る全スクリプトから import して使う。
// (generate-monthly-report.mjs / meta-ads-report.mjs / clarity-report.mjs 等)

import puppeteer from "puppeteer";

export const BRAND = "#E87030";
export const BRAND_DARK = "#a04a1e";
export const INK = "#0b0b0b";
export const INK_SECONDARY = "#52514e";
export const INK_MUTED = "#898781";
export const GRID = "#e1e0d9";
export const SURFACE = "#fcfcfb";
export const GOOD = "#006300";
export const CRITICAL = "#d03b3b";

// カテゴリ配色(ブランドオレンジと衝突するslot2は使わず、blue/aqua/yellow/magentaを使用)
export const CAT = { blue: "#2a78d6", aqua: "#1baf7a", yellow: "#eda100", magenta: "#e87ba4", violet: "#4a3aa7" };
export const SEQ_BLUE = { 250: "#86b6ef", 400: "#3987e5", 550: "#1c5cab" }; // ordinal funnel steps

export function yen(n) {
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}
export function num(n) {
  return Math.round(n).toLocaleString("ja-JP");
}
export function pct(n, digits = 1) {
  return `${n.toFixed(digits)}%`;
}

// current: 直近値, previous: 比較対象値。higherIsBetter=falseなら減少が「good」
export function delta({ current, previous, unit = "%", higherIsBetter = true, digits = 1 }) {
  if (previous === 0 || previous === undefined || previous === null) return { text: "―", cls: "flat" };
  const diff = unit === "pt" ? current - previous : ((current - previous) / Math.abs(previous)) * 100;
  const isUp = diff > 0;
  const isFlat = Math.abs(diff) < 0.05;
  const good = isFlat ? true : higherIsBetter ? isUp : !isUp;
  const arrow = isFlat ? "→" : isUp ? "▲" : "▼";
  const text = `${arrow} ${Math.abs(diff).toFixed(digits)}${unit === "pt" ? "pt" : "%"}`;
  return { text, cls: isFlat ? "flat" : good ? "good" : "bad" };
}

function polar(cx, cy, r, angleDeg) {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
function donutSlicePath(cx, cy, rOuter, rInner, startAngle, endAngle) {
  const so = polar(cx, cy, rOuter, endAngle);
  const eo = polar(cx, cy, rOuter, startAngle);
  const si = polar(cx, cy, rInner, startAngle);
  const ei = polar(cx, cy, rInner, endAngle);
  const large = endAngle - startAngle > 180 ? 1 : 0;
  return [
    `M ${so.x.toFixed(2)} ${so.y.toFixed(2)}`,
    `A ${rOuter} ${rOuter} 0 ${large} 0 ${eo.x.toFixed(2)} ${eo.y.toFixed(2)}`,
    `L ${si.x.toFixed(2)} ${si.y.toFixed(2)}`,
    `A ${rInner} ${rInner} 0 ${large} 1 ${ei.x.toFixed(2)} ${ei.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

// ドーナツチャート。segments: [{label, value}], colors: 使用する色配列(固定順で割当)
export function donutChart(segments, colors, { size = 200 } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 6;
  const rInner = rOuter * 0.6;
  let angle = 0;
  const slices = segments
    .map((seg, i) => {
      const sweep = (seg.value / total) * 360;
      const path = donutSlicePath(cx, cy, rOuter, rInner, angle, angle + sweep);
      angle += sweep;
      return `<path d="${path}" fill="${colors[i % colors.length]}" stroke="${SURFACE}" stroke-width="2"/>`;
    })
    .join("");
  const legend = segments
    .map(
      (seg, i) =>
        `<div class="legend-row"><span class="dot" style="background:${colors[i % colors.length]}"></span>${seg.label}　<span class="legend-val">${pct((seg.value / total) * 100, 0)}</span></div>`
    )
    .join("");
  return `<div class="donut-wrap"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${slices}</svg><div class="legend">${legend}</div></div>`;
}

// 折れ線チャート(単一系列)。values: number[], labels: string[]
export function lineChart(values, labels, { width = 480, height = 170, color = CAT.blue, valueFmt = num, padTop = 24 } = {}) {
  const min = Math.min(...values) * 0.9;
  const max = Math.max(...values) * 1.08;
  const compact = width < 300;
  const labelFontSize = compact ? 11 : 13;
  const lastText = valueFmt(values[values.length - 1]);
  // ラベル文字数から必要な右余白を見積もる(はみ出し・見切れ防止)
  const labelWidth = lastText.length * labelFontSize * 0.62 + 10;
  const left = 8;
  const right = width - labelWidth;
  const top = padTop;
  const bottom = height - 28;
  const xStep = (right - left) / (values.length - 1);
  const y = (v) => bottom - ((v - min) / (max - min)) * (bottom - top);
  const points = values.map((v, i) => ({ x: left + i * xStep, y: y(v), v }));
  const poly = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const gridLines = [0, 0.5, 1]
    .map((t) => {
      const gy = bottom - t * (bottom - top);
      return `<line x1="${left}" y1="${gy.toFixed(1)}" x2="${right}" y2="${gy.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`;
    })
    .join("");
  const dots = points
    .map(
      (p, i) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${i === points.length - 1 ? 5 : 4}" fill="${color}" stroke="${SURFACE}" stroke-width="1.5"/>`
    )
    .join("");
  const lastLabel = `<text x="${points[points.length - 1].x + 8}" y="${points[points.length - 1].y + 4}" font-size="${labelFontSize}" font-weight="600" fill="${INK}">${lastText}</text>`;
  const xLabels = points
    .map((p, i) => `<text x="${p.x.toFixed(1)}" y="${height - 6}" font-size="11" fill="${INK_MUTED}" text-anchor="middle">${labels[i]}</text>`)
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="overflow:visible">${gridLines}<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>${dots}${lastLabel}${xLabels}</svg>`;
}

// 縦棒チャート(単一系列)
export function barChart(values, labels, { width = 480, height = 170, color = CAT.blue, valueFmt = num } = {}) {
  const max = Math.max(...values) * 1.15;
  const left = 8;
  const right = width - 8;
  const top = 22;
  const bottom = height - 28;
  const n = values.length;
  const gap = 14;
  const barW = (right - left - gap * (n - 1)) / n;
  const y = (v) => bottom - (v / max) * (bottom - top);
  const bars = values
    .map((v, i) => {
      const x = left + i * (barW + gap);
      const by = y(v);
      const h = bottom - by;
      return `<rect x="${x.toFixed(1)}" y="${by.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}"/>`;
    })
    .join("");
  const labelsSvg = values
    .map((v, i) => {
      const x = left + i * (barW + gap) + barW / 2;
      const by = y(v);
      return `<text x="${x.toFixed(1)}" y="${(by - 6).toFixed(1)}" font-size="11" fill="${INK_SECONDARY}" text-anchor="middle">${valueFmt(v)}</text><text x="${x.toFixed(1)}" y="${height - 6}" font-size="11" fill="${INK_MUTED}" text-anchor="middle">${labels[i]}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}">${bars}${labelsSvg}</svg>`;
}

// 横棒チャート(複数カテゴリの単純比較。長さ順ソートは呼び出し側で行う)
export function hBarChart(items, { width = 480, color = CAT.blue, valueFmt = num, barH = 30, gap = 10 } = {}) {
  const max = Math.max(...items.map((i) => i.value)) * 1.1;
  const labelW = Math.max(...items.map((i) => i.label.length)) * 7 + 16;
  const barMaxW = width - labelW - 60;
  const rowH = barH + gap;
  const height = rowH * items.length + gap;
  const rows = items
    .map((it, i) => {
      const w = (it.value / max) * barMaxW;
      const y = i * rowH + gap / 2;
      return `
        <text x="0" y="${y + barH / 2 + 4}" font-size="12" fill="${INK_SECONDARY}">${it.label}</text>
        <rect x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="4" fill="${it.color || color}"/>
        <text x="${labelW + w + 8}" y="${y + barH / 2 + 4}" font-size="13" font-weight="600" fill="${INK}">${valueFmt(it.value)}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="overflow:visible">${rows}</svg>`;
}

// ファネルチャート(横棒、段階が進むほど濃い色=ordinalランプ)
export function funnelChart(stages, { width = 480 } = {}) {
  const max = Math.max(...stages.map((s) => s.value));
  const rowH = 64;
  const height = rowH * stages.length + 10;
  const labelW = 90;
  const barMaxW = width - labelW - 60;
  const colors = [SEQ_BLUE[250], SEQ_BLUE[400], SEQ_BLUE[550]];
  const barH = 34;
  const rows = stages
    .map((s, i) => {
      const w = (s.value / max) * barMaxW;
      const y = i * rowH + (rowH - barH) / 2;
      const rate = i === 0 ? "" : `<tspan fill="${INK_MUTED}" font-size="11"> (前段階比 ${pct((s.value / stages[i - 1].value) * 100, 0)})</tspan>`;
      return `
        <text x="0" y="${y + barH / 2 + 4}" font-size="13" fill="${INK_SECONDARY}">${s.label}</text>
        <rect x="${labelW}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="5" fill="${colors[i % colors.length]}"/>
        <text x="${labelW + w + 10}" y="${y + barH / 2 + 4}" font-size="14" font-weight="600" fill="${INK}">${num(s.value)}件${rate}</text>`;
    })
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="overflow:visible">${rows}</svg>`;
}

export function kpiTile({ label, value, deltas = [] }) {
  const deltaHtml = deltas.map((d) => `<span class="d ${d.cls}">${d.label}: ${d.text}</span>`).join("");
  return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div><div class="kpi-deltas">${deltaHtml}</div></div>`;
}

export function pageHeader(title, subtitle) {
  return `
    <div class="hdr">
      <div>
        <div class="hdr-title">${title}</div>
        <div class="hdr-sub">${subtitle}</div>
      </div>
      <div class="hdr-logo">ZenNu <span>WELLNESS DESIGN</span></div>
    </div>`;
}

export function card(title, bodyHtml, extraClass = "") {
  return `<div class="card ${extraClass}"><div class="card-title">${title}</div><div class="card-body">${bodyHtml}</div></div>`;
}

export function callout(text, { icon = "💡", warn = false } = {}) {
  return `<div class="callout ${warn ? "warn" : ""}"><span class="callout-icon">${icon}</span><span>${text}</span></div>`;
}

export function tableHtml(headers, rows) {
  const thead = `<tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  const tbody = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("");
  return `<table class="tbl"><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

export const PAGE_CSS = `
  @page { size: 297mm 210mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; color: ${INK}; }
  .sheet { width: 297mm; height: 210mm; padding: 14mm 16mm; page-break-after: always; position: relative; display: flex; flex-direction: column; }
  .sheet:last-child { page-break-after: avoid; }
  .hdr { display: flex; justify-content: space-between; align-items: center; background: linear-gradient(100deg, ${BRAND}, ${BRAND_DARK}); color: #fff; border-radius: 10px; padding: 16px 22px; margin-bottom: 16px; }
  .hdr-title { font-size: 20px; font-weight: 700; }
  .hdr-sub { font-size: 12px; opacity: 0.9; margin-top: 2px; }
  .hdr-logo { font-size: 15px; font-weight: 700; letter-spacing: 0.5px; }
  .hdr-logo span { font-weight: 400; opacity: 0.85; font-size: 11px; display: block; text-align: right; }
  .kpi-row { display: flex; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .kpi { flex: 1; min-width: 140px; background: #fff; border: 1px solid ${GRID}; border-left: 4px solid ${BRAND}; border-radius: 8px; padding: 10px 14px; }
  .kpi-label { font-size: 11.5px; color: ${INK_SECONDARY}; margin-bottom: 4px; }
  .kpi-value { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .kpi-deltas { margin-top: 4px; display: flex; flex-direction: column; gap: 1px; }
  .d { font-size: 10.5px; }
  .d.good { color: ${GOOD}; }
  .d.bad { color: ${CRITICAL}; }
  .d.flat { color: ${INK_MUTED}; }
  .callout { display: flex; gap: 10px; align-items: flex-start; background: #FDF2EA; border: 1px solid #f0d9c4; border-radius: 8px; padding: 10px 16px; font-size: 12.5px; color: ${INK}; margin-bottom: 14px; }
  .callout.warn { background: #fff6e8; border-color: #f3d99b; }
  .callout-icon { font-size: 16px; }
  .callout-list { display: flex; flex-direction: column; gap: 6px; flex: 1; overflow: hidden; }
  .callout-list .callout { margin-bottom: 0; padding: 7px 14px; font-size: 11px; line-height: 1.45; }
  .callout-list .callout-icon { font-size: 13px; }
  .row-2 { display: flex; gap: 14px; flex: 1; }
  .row-2-inner { display: flex; gap: 8px; }
  .card { flex: 1; background: #fff; border: 1px solid ${GRID}; border-radius: 8px; padding: 12px 16px; display: flex; flex-direction: column; }
  .card-body { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .card-title { font-size: 13px; font-weight: 700; color: ${INK}; margin-bottom: 8px; border-left: 4px solid ${BRAND}; padding-left: 8px; }
  .donut-wrap { display: flex; align-items: center; gap: 20px; justify-content: center; flex: 1; }
  .legend { display: flex; flex-direction: column; gap: 6px; }
  .legend-row { font-size: 12px; color: ${INK_SECONDARY}; display: flex; align-items: center; }
  .legend-val { font-weight: 700; color: ${INK}; margin-left: 4px; }
  .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  .tbl th { background: #FDF2EA; color: ${BRAND_DARK}; padding: 6px 8px; text-align: center; }
  .tbl td { padding: 6px 8px; text-align: center; border-bottom: 1px solid ${GRID}; font-variant-numeric: tabular-nums; }
  .formula { display: flex; align-items: center; gap: 14px; justify-content: center; background: #fff; border: 1px solid ${GRID}; border-radius: 8px; padding: 20px; margin-bottom: 14px; font-size: 15px; font-weight: 700; }
  .f-box { background: #FDF2EA; border-radius: 6px; padding: 10px 18px; }
  .f-eq { color: ${INK_MUTED}; font-size: 18px; }
  .f-delta { font-size: 11px; font-weight: 500; margin-left: 6px; }
  .sample-banner { position: fixed; top: 8px; right: 12px; background: rgba(211,59,59,0.12); color: ${CRITICAL}; font-size: 9px; font-weight: 700; padding: 2px 8px; border-radius: 4px; letter-spacing: 0.5px; }
`;

// pages: HTML文字列の配列(各要素が1枚の<div class="sheet">...</div>)
export function wrapDocument(pages, { sampleBanner = "" } = {}) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>${PAGE_CSS}</style></head>
<body>
${sampleBanner ? `<div class="sample-banner">${sampleBanner}</div>` : ""}
${pages.join("\n")}
</body></html>`;
}

// HTML文字列をA4横PDFとして書き出す
export async function renderPdfFromHtml(html, outPath) {
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    await page.pdf({ path: outPath, printBackground: true, width: "297mm", height: "210mm" });
  } finally {
    await browser.close();
  }
}
