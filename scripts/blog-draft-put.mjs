// ブログ/ニュース記事をmicroCMSに「下書き」状態でPUT保存するヘルパー。
// zennu-blog-weekly-draft / grovit-news-weekly-draft スケジュールタスクから呼ばれる想定。
// 生のcurlコマンドだと引数(一時ファイルパス)が実行のたびに変わり、
// 許可リストに安定して登録できないため、コマンド形が固定になるようスクリプト化した。
//
// 前提:
//   - 書き込み用APIキーが ~/.zennu-lp-secrets/microcms-write-key.txt にある
//
// 実行: node scripts/blog-draft-put.mjs <記事JSONファイルパス>
//   JSONファイルの中身: { endpoint, id, title, slug, category, excerpt, body, noindex, ... }
//   - endpoint: microCMSのAPIエンドポイント名。省略時は "blogs"（ZenNuブログ用のデフォルト）
//   - id: コンテンツID。省略時は slug フィールドを使う（ZenNuブログはslugをIDとして使う運用のため）
//   - endpoint/id 以外のフィールドはそのままPUTのボディとして送信される

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = path.join(os.homedir(), ".zennu-lp-secrets");
const KEY_PATH = path.join(SECRETS_DIR, "microcms-write-key.txt");

function loadKey() {
  if (!fs.existsSync(KEY_PATH)) {
    throw new Error(`microCMS書き込みキーが見つかりません: ${KEY_PATH}`);
  }
  return fs.readFileSync(KEY_PATH, "utf-8").trim();
}

export async function putDraft(rawEntry) {
  const { endpoint = "blogs", id, ...entry } = rawEntry;
  const contentId = id || entry.slug;
  if (!contentId) throw new Error("記事データにid(またはslug)がありません");
  const key = loadKey();
  const res = await fetch(
    `https://zennuwellness.microcms.io/api/v1/${endpoint}/${contentId}?status=draft`,
    {
      method: "PUT",
      headers: {
        "X-MICROCMS-API-KEY": key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(entry),
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`microCMS下書き保存失敗: ${res.status} ${text}`);
  }
  return { status: res.status, body: text };
}

async function main() {
  const jsonPath = process.argv[2];
  if (!jsonPath) {
    console.error("使い方: node scripts/blog-draft-put.mjs <記事JSONファイルパス>");
    process.exit(1);
  }
  const entry = JSON.parse(fs.readFileSync(path.resolve(jsonPath), "utf-8"));
  const result = await putDraft(entry);
  console.log(`下書き保存に成功しました (${result.status}):`, result.body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("下書き保存でエラーが発生しました:", err.message);
    process.exit(1);
  });
}
