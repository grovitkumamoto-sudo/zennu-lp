// 週次レポートの主要指標を蓄積して推移グラフを描けるようにするための共有ヘルパー。
// Clarity・PostHog・Meta広告など、APIが直近数日/数週間分しか返さないデータソースは
// これ自体では「過去30日推移」等が作れないため、レポート実行のたびに1スナップショットを
// 追記し、蓄積したぶんだけ推移グラフとして描画する(蓄積は今後の実行分から始まる。
// 過去に遡ってのバックフィルはできない)。
//
// 保存先: scripts/report-history/{name}.json (実データのため.gitignore対象)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_DIR = path.join(__dirname, "report-history");

function filePath(name) {
  return path.join(HISTORY_DIR, `${name}.json`);
}

export function loadHistory(name) {
  const p = filePath(name);
  if (!fs.existsSync(p)) return [];
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
}

// snapshotには { date: "YYYY-MM-DD", ...任意の指標 } を渡す。
// 同じ日付のスナップショットが既にあれば上書きする(同日に複数回実行しても重複しない)。
export function appendHistory(name, snapshot, { maxEntries = 52 } = {}) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  const history = loadHistory(name);
  const idx = history.findIndex((h) => h.date === snapshot.date);
  if (idx >= 0) {
    history[idx] = snapshot;
  } else {
    history.push(snapshot);
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  const trimmed = history.slice(-maxEntries);
  fs.writeFileSync(filePath(name), JSON.stringify(trimmed, null, 2));
  return trimmed;
}
