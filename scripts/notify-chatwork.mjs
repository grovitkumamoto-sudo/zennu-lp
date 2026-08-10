// Chatworkへの通知送信ヘルパー。他のスクリプトからimportして使う。
//
// 前提:
//   - APIトークンが ~/.zennu-lp-secrets/chatwork-token.txt にある
//   - 送信先ルームIDは scripts/seo-config.json の chatworkRoomId
//
// 単体実行: node scripts/notify-chatwork.mjs "テストメッセージ"

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRETS_DIR = path.join(os.homedir(), ".zennu-lp-secrets");
const TOKEN_PATH = path.join(SECRETS_DIR, "chatwork-token.txt");
const CONFIG_PATH = path.join(__dirname, "seo-config.json");

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Chatwork APIトークンが見つかりません: ${TOKEN_PATH}`);
  }
  return fs.readFileSync(TOKEN_PATH, "utf-8").trim();
}

function loadRoomId() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  if (!config.chatworkRoomId) {
    throw new Error(`scripts/seo-config.json に chatworkRoomId が設定されていません`);
  }
  return config.chatworkRoomId;
}

// プレーンテキストメッセージを送信する
export async function sendChatworkMessage(body) {
  const token = loadToken();
  const roomId = loadRoomId();
  const res = await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/messages`, {
    method: "POST",
    headers: {
      "X-ChatWorkToken": token,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ body }),
  });
  if (!res.ok) {
    throw new Error(`Chatworkメッセージ送信失敗: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// ファイルを添付して送信する(messageは任意のキャプション)
export async function sendChatworkFile(filePath, message = "") {
  const token = loadToken();
  const roomId = loadRoomId();
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  if (message) form.append("message", message);

  const res = await fetch(`https://api.chatwork.com/v2/rooms/${roomId}/files`, {
    method: "POST",
    headers: { "X-ChatWorkToken": token },
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Chatworkファイル送信失敗: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// CLIから直接実行された場合はテストメッセージを送信
if (import.meta.url === `file://${process.argv[1]}`) {
  const text = process.argv[2] || "notify-chatwork.mjs からのテスト送信です。";
  sendChatworkMessage(text)
    .then((r) => console.log("送信成功:", r))
    .catch((e) => {
      console.error("送信失敗:", e.message);
      process.exit(1);
    });
}
