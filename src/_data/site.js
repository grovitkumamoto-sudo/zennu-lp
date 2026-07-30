// サイトのコンテンツデータ。
// 基本は lib/content-defaults.json（=これまでの site.json）を使い、
// microCMS にデータがあればその項目だけ上書きする。
// MICROCMS_API_KEY が未設定でも必ずデフォルトで動く（ビルドは壊れない）。

const path = require("path");
const defaults = require(path.join(__dirname, "..", "..", "lib", "content-defaults.json"));

const DOMAIN = "zennuwellness"; // microCMS サービスID

async function mc(endpoint, query = "") {
  const res = await fetch(
    `https://${DOMAIN}.microcms.io/api/v1/${endpoint}${query}`,
    { headers: { "X-MICROCMS-API-KEY": process.env.MICROCMS_API_KEY } }
  );
  if (!res.ok) throw new Error(`${endpoint} -> HTTP ${res.status}`);
  return res.json();
}

// microCMSの画像フィールドは {url} オブジェクト。文字列パスとの両対応。
const img = (v, fallback) => (v && v.url) ? v.url : (typeof v === "string" && v ? v : fallback);
// テキストエリア（改行区切り）→ 配列
const lines = (v) => String(v || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

// リストAPIを取得して defaults を置き換える共通処理（空・失敗時はデフォルト維持）
async function applyList(data, endpoint, target, mapFn, query = "?limit=100") {
  try {
    const { contents } = await mc(endpoint, query);
    if (Array.isArray(contents) && contents.length) {
      target(data, contents.map(mapFn));
      console.log(`[microCMS] ${endpoint} 反映 (${contents.length}件)`);
    }
  } catch (e) {
    console.warn(`[microCMS] ${endpoint} スキップ:`, e.message);
  }
}

module.exports = async function () {
  // ディープコピー（デフォルトを壊さない）
  const data = JSON.parse(JSON.stringify(defaults));

  // APIキーが無い（ローカル開発・未設定）ならデフォルトのまま
  if (!process.env.MICROCMS_API_KEY) {
    console.log("[microCMS] APIキー未設定のためデフォルト(content-defaults.json)を使用");
    return data;
  }

  // ── サイト設定（オブジェクト形式 API: "settings"）──
  try {
    const s = await mc("settings");
    if (s.remaining != null && s.remaining !== "") data.campaign.remaining = s.remaining;
    if (s.bandText) data.campaign.bandText = s.bandText;
    if (s.heroJp) data.hero.jp = s.heroJp;
    if (s.heroEn) data.hero.headline = s.heroEn;
    if (s.heroDesc) data.hero.desc = s.heroDesc;
    if (s.introJp) data.intro.jp = s.introJp;
    if (s.introEn) data.intro.en = s.introEn;
    if (s.lineUrl) data.contact.lineUrl = s.lineUrl;
    if (s.tel) {
      data.contact.telDisplay = s.tel;
      data.contact.tel = String(s.tel).replace(/[^0-9]/g, "");
    }
    console.log("[microCMS] settings 反映");
  } catch (e) {
    console.warn("[microCMS] settings スキップ:", e.message);
  }

  // ── FAQ（リスト形式 API: "faq" / フィールド: q, a）──
  await applyList(data, "faq", (d, items) => { d.faq.items = items; },
    (c) => ({ q: c.question, a: c.answer }));

  // ── お客様の声（リスト形式 API: "voice"）──
  await applyList(data, "voice", (d, items) => { d.memberVoice.items = items; },
    (c) => ({
      image: img(c.image, "/images/ba1.jpg"),
      tag: c.tag, result: c.result, unit: c.unit,
      label: c.label, meta: c.meta, quote: c.quote, who: c.who,
      story: c.story, duration: c.duration,
      weightKg: c.weightKg, bodyFatPct: c.bodyFatPct,
      journey: c.journey ? lines(c.journey) : null,
      currentRoutine: c.currentRoutine ? lines(c.currentRoutine) : null,
    }));

  // ── トレーナー（リスト形式 API: "trainer"）──
  await applyList(data, "trainer", (d, items) => { d.trainers.items = items; },
    (c) => ({
      portrait: img(c.portrait, ""),
      jp: c.jp, en: c.en, bio: c.bio,
      tags: lines(c.tags),
      actionImage: img(c.actionImage, ""),
      reverse: !!c.reverse,
    }));

  // ── LP訴求違いページ（リスト形式 API: "lpVariants"）──
  // slugで /{slug}/ にページ生成。各フィールドは空ならヒーローのデフォルトを使用
  await applyList(data, "lpVariants", (d, items) => { d.lpVariants = items; },
    (c) => ({
      slug: c.slug,
      eyebrow: c.heroEyebrow,
      headline: c.heroEn,
      jp: c.heroJp,
      desc: c.heroDesc,
      image: img(c.heroImage, ""),
    }));

  // ── ブログ記事（リスト形式 API: "blogs"）──
  await applyList(data, "blogs", (d, items) => { d.blogPosts = items; },
    (c) => ({
      title: c.title,
      slug: c.slug,
      eyecatch: img(c.eyecatch, "/images/hero.jpg"),
      category: c.category || "",
      excerpt: c.excerpt || "",
      body: c.body || "",
      publishedAt: c.publishedAt,
      noindex: !!c.noindex,
    }), "?limit=100&orders=-publishedAt");

  // ── 料金プラン（リスト形式 API: "plan"）──
  await applyList(data, "plan", (d, items) => { d.pricing.plans = items; },
    (c) => ({
      name: c.name, for: c.planFor, price: c.price, unit: c.unit,
      popular: !!c.popular, items: lines(c.items),
    }));

  // ── ギャラリー（リスト形式 API: "gallery"）──
  await applyList(data, "gallery", (d, items) => { d.gallery.items = items; },
    (c) => ({ image: img(c.image, ""), label: c.label, size: c.size || "" }));

  return data;
};
