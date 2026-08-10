// MarkdownレポートをブランドカラーのPDFに変換するスクリプト。
// 他のスクリプトからimportして使うか、CLIで直接実行する。
//
// 実行: node scripts/md-to-pdf.mjs <入力.md> [出力.pdf]

import fs from "node:fs";
import path from "node:path";
import { marked } from "marked";
import puppeteer from "puppeteer";

const CSS = `
  body { font-family: "Hiragino Sans", "Noto Sans JP", sans-serif; color: #1a1a1a; line-height: 1.7; padding: 48px 56px; font-size: 13px; }
  h1 { color: #E87030; font-size: 22px; border-bottom: 3px solid #E87030; padding-bottom: 10px; margin-bottom: 20px; }
  h2 { color: #E87030; font-size: 16px; margin-top: 28px; border-left: 5px solid #E87030; padding-left: 10px; }
  h3 { font-size: 14px; margin-top: 18px; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0 20px; font-size: 11.5px; table-layout: fixed; }
  th, td { border: 1px solid #E8E0D8; padding: 6px 10px; text-align: left; word-break: break-all; overflow-wrap: anywhere; }
  th { background: #FDF2EA; color: #a04a1e; }
  code { background: #FDF2EA; padding: 1px 5px; border-radius: 3px; font-size: 11px; }
  a { color: #E87030; }
  ul, ol { margin: 8px 0; padding-left: 22px; }
  .report-footer { margin-top: 32px; padding-top: 12px; border-top: 1px solid #E8E0D8; color: #999; font-size: 10.5px; }
`;

export async function convertMarkdownToPdf(mdPath, pdfPath) {
  const md = fs.readFileSync(mdPath, "utf-8");
  const html = marked.parse(md);
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${CSS}</style></head><body>${html}<div class="report-footer">ZenNu WELLNESS DESIGN 自動レポート ／ 生成日時: ${new Date().toLocaleString("ja-JP")}</div></body></html>`;

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(fullHtml, { waitUntil: "networkidle0" });
    await page.pdf({
      path: pdfPath,
      format: "A4",
      margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
  return pdfPath;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("使い方: node scripts/md-to-pdf.mjs <入力.md> [出力.pdf]");
    process.exit(1);
  }
  const outputPath = process.argv[3] || inputPath.replace(/\.md$/, ".pdf");
  convertMarkdownToPdf(inputPath, outputPath)
    .then(() => console.log(`PDF生成完了: ${outputPath}`))
    .catch((e) => {
      console.error("PDF生成失敗:", e.message);
      process.exit(1);
    });
}
