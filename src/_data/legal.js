const fs = require("fs");
const path = require("path");
const MarkdownIt = require("markdown-it");

const DOMAIN = "zennuwellness";
const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
});

const documents = {
  terms: {
    documentType: "terms",
    slug: "terms",
    title: "会員・施設利用規約",
    description: "ZenNu WELLNESS DESIGNの会員・施設利用規約です。",
    source: "terms.md",
  },
  corporateTerms: {
    documentType: "corporateTerms",
    slug: "corporate-terms",
    title: "法人会員利用規約",
    description: "ZenNu WELLNESS DESIGNの法人会員利用規約です。",
    source: "corporate-terms.md",
  },
  privacy: {
    documentType: "privacy",
    slug: "privacy",
    title: "プライバシーポリシー",
    description: "株式会社GroVitおよびZenNu WELLNESS DESIGNの個人情報取扱方針です。",
    source: "privacy.md",
  },
  law: {
    documentType: "law",
    slug: "law",
    title: "特定商取引法に基づく表記",
    description: "ZenNu WELLNESS DESIGNの特定商取引法に基づく表記です。",
    source: "law.md",
  },
};

function loadFallback(document) {
  const sourcePath = path.join(
    __dirname,
    "..",
    "..",
    "content",
    "legal",
    document.source
  );
  const source = fs
    .readFileSync(sourcePath, "utf8")
    .replace(/^# .+\r?\n+/, "");

  return {
    ...document,
    version: "2026.1",
    effectiveDate: "2026-08-05",
    body: markdown.render(source),
    source: "fallback",
  };
}

async function loadCurrentVersions() {
  const response = await fetch(
    `https://${DOMAIN}.microcms.io/api/v1/legal-versions?filters=isCurrent%5Bequals%5Dtrue&limit=100`,
    {
      headers: {
        "X-MICROCMS-API-KEY": process.env.MICROCMS_API_KEY,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`legal-versions -> HTTP ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload.contents) ? payload.contents : [];
}

module.exports = async function () {
  const data = Object.fromEntries(
    Object.entries(documents).map(([key, document]) => [
      key,
      loadFallback(document),
    ])
  );

  if (!process.env.MICROCMS_API_KEY) {
    return data;
  }

  try {
    const currentVersions = await loadCurrentVersions();

    for (const version of currentVersions) {
      const key = Object.keys(documents).find(
        (candidate) =>
          documents[candidate].documentType === version.documentType
      );

      if (!key || !version.body) continue;

      data[key] = {
        ...data[key],
        title: version.title || data[key].title,
        description: version.seoDescription || data[key].description,
        version: version.version || data[key].version,
        effectiveDate: version.effectiveDate || data[key].effectiveDate,
        body: version.body,
        source: "microCMS",
      };
    }
  } catch (error) {
    console.warn(`[microCMS] legal-versions スキップ: ${error.message}`);
  }

  return data;
};
