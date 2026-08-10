// Googleビジネスプロフィールの アカウントID・店舗(ロケーション)ID を確認するための
// 一度だけ実行するヘルパースクリプト。
//
// 前提:
//   - node scripts/oauth-authorize.mjs を business.manage スコープ込みで実行済み
//
// 実行: node scripts/meo-list-locations.mjs
//
// 出力されたロケーション名(accounts/xxx/locations/yyy)を
// scripts/meo-config.json の locationName に設定してください。

import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const SECRETS_DIR = path.join(os.homedir(), ".zennu-lp-secrets");
const CLIENT_PATH = path.join(SECRETS_DIR, "google-oauth-client.json");
const TOKEN_PATH = path.join(SECRETS_DIR, "google-oauth-token.json");

async function getAuth() {
  const { client_id, client_secret } = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
  oauth2Client.setCredentials(tokens);
  return oauth2Client;
}

async function main() {
  const auth = await getAuth();

  const accountMgmt = google.mybusinessaccountmanagement({ version: "v1", auth });
  const businessInfo = google.mybusinessbusinessinformation({ version: "v1", auth });

  const { data: accountsRes } = await accountMgmt.accounts.list();
  const accounts = accountsRes.accounts || [];

  if (accounts.length === 0) {
    console.log("アカウントが見つかりませんでした。このGoogleアカウントがビジネスプロフィールのオーナー/管理者になっているか確認してください。");
    return;
  }

  for (const account of accounts) {
    console.log(`\nアカウント: ${account.accountName} (${account.name})`);
    const { data: locationsRes } = await businessInfo.accounts.locations.list({
      parent: account.name,
      readMask: "name,title,storefrontAddress",
    });
    const locations = locationsRes.locations || [];
    for (const loc of locations) {
      console.log(`  店舗: ${loc.title}`);
      console.log(`  住所: ${loc.storefrontAddress?.addressLines?.join(" ") || "(不明)"}`);
      console.log(`  → locationName: ${loc.name}`);
    }
  }
}

main().catch((err) => {
  console.error("取得に失敗しました:", err.message);
  process.exit(1);
});
