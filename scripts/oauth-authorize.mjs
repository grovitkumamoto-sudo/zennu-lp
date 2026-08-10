// 一度だけ実行するOAuth認証スクリプト。
// ローカルに一時サーバーを立て、ブラウザでGoogleにログイン・承認してもらい、
// refresh_tokenを取得して ~/.zennu-lp-secrets/google-oauth-token.json に保存する。
//
// 実行: node scripts/oauth-authorize.mjs
// 実行後、表示されるURLをブラウザで開いて承認してください。

import { google } from "googleapis";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { URL } from "node:url";

const SECRETS_DIR = path.join(os.homedir(), ".zennu-lp-secrets");
const CLIENT_PATH = path.join(SECRETS_DIR, "google-oauth-client.json");
const TOKEN_PATH = path.join(SECRETS_DIR, "google-oauth-token.json");
const PORT = 53682;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/business.manage",
];

function loadClient() {
  const { client_id, client_secret } = JSON.parse(fs.readFileSync(CLIENT_PATH, "utf-8"));
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

async function main() {
  const oauth2Client = loadClient();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });

  console.log("\n以下のURLをブラウザで開いて、Googleアカウントでログイン・承認してください:\n");
  console.log(authUrl);
  console.log("\n承認完了を待っています...\n");

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (error) {
        res.end(`<h1>認証に失敗しました</h1><p>${error}</p><p>このタブを閉じてターミナルに戻ってください。</p>`);
        server.close();
        reject(new Error(error));
        return;
      }
      res.end("<h1>認証完了しました</h1><p>このタブを閉じてターミナルに戻ってください。</p>");
      server.close();
      resolve(code);
    });
    server.listen(PORT);
  });

  const { tokens } = await oauth2Client.getToken(code);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf-8");
  fs.chmodSync(TOKEN_PATH, 0o600);

  console.log(`refresh_tokenを保存しました: ${TOKEN_PATH}`);
  if (!tokens.refresh_token) {
    console.warn("\n注意: refresh_tokenが取得できませんでした。既に一度承認済みだと発行されないことがあります。");
    console.warn("Googleアカウントの設定 > セキュリティ > サードパーティのアクセス で本アプリの接続を一度解除してから再実行してください。");
  }
}

main().catch((err) => {
  console.error("認証中にエラーが発生しました:", err.message);
  process.exit(1);
});
