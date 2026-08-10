module.exports = function (eleventyConfig) {
  // 画像・静的ツールはそのままコピー
  eleventyConfig.addPassthroughCopy({ "src/images": "images" });
  eleventyConfig.addPassthroughCopy({ "src/videos": "videos" });
  eleventyConfig.addPassthroughCopy({ "src/static": "." });
  eleventyConfig.addPassthroughCopy({ "src/robots.txt": "robots.txt" });

  // static配下のHTMLはテンプレート処理せずコピーのみ
  eleventyConfig.ignores.add("src/static/**");

  // LP訴求違いページ用: site.heroをvariantの値で上書きしたコピーを返す
  // (空でないフィールドだけ上書き。site本体は書き換えない)
  eleventyConfig.addFilter("withHero", (site, variant) => {
    const next = JSON.parse(JSON.stringify(site));
    ["eyebrow", "headline", "jp", "desc", "image"].forEach((key) => {
      if (variant[key]) next.hero[key] = variant[key];
    });
    return next;
  });

  // /cp1lp/ など階層下のページでも、ローカル画像を必ずサイトルートから参照する。
  // microCMS の絶対URLと、すでにルート相対になっているパスはそのまま返す。
  eleventyConfig.addFilter("mediaUrl", (value) => {
    const src = value && value.url ? value.url : value;
    if (!src || typeof src !== "string") return "";
    if (/^(?:https?:)?\/\//.test(src) || src.startsWith("/")) return src;
    return `/${src.replace(/^\.\//, "")}`;
  });

  // ブログ記事の公開日を YYYY-MM-DD 表示にする
  eleventyConfig.addFilter("dateOnly", (s) => (s ? String(s).slice(0, 10) : ""));

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk",
  };
};
