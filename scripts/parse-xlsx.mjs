// 讀取 data/Stock_data_collection.xlsx 的市場分頁，轉換為 src/data/market_data.json 供前端直接 import。
// 用法：node scripts/parse-xlsx.mjs [輸入檔路徑] [輸出檔路徑]
// 預設：node scripts/parse-xlsx.mjs data/Stock_data_collection.xlsx src/data/market_data.json
//
// 支援的市場分頁（MARKETS）：
//   TW：「TWN historical data」（錨點標的 0050）
//   US：「VTS historical data」（錨點標的 SPY）；NQ：「NASDAQ historical data」（錨點標的 QQQ）
//   找不到美股分頁時略過該市場（只警告，不中斷）
//
// 標的欄位自動偵測（欄位標題正規化＝去空白、轉小寫後比對）：
//   「<代號>price」或「<代號>close」＝收盤價、「<代號>openprice」或「<代號>open」＝開盤價；之後新增 ETF 只要照這個命名加欄位即可，
//   不需要改程式。只有收盤價（如 IX0001、2330）的標的只能當「訊號標的」，不能當輪動持有標的。
// 選填欄位：任何包含 "rollyield" 的欄位（VX30:VIX Roll Yield）、"vix"（VIX）
// 列的取捨：只保留「錨點標的」收盤＋開盤價都有值的日期；其他標的的缺值會往前／往後補值
// （開頭的缺值以第一筆有效價回填成「佔位資料」，App 端會偵測並提示）。

import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const inputPath = path.resolve(repoRoot, process.argv[2] || "data/Stock_data_collection.xlsx");
const outputPath = path.resolve(repoRoot, process.argv[3] || "src/data/market_data.json");

// 注意：這裡刻意不對日期設下限。00631L/00635U/0050 等價格欄位在 2014-11-03
// 之前於原始檔案中是用常數回填的佔位資料（ETF尚未真正存在），但 VX30:VIX
// Roll Yield 欄位在此之前有真實歷史資料（本檔案回溯至 2007 年），保留完整
// 歷史讓 App 端的 VIX 滾動視窗（預設 1000 個交易日）從 2014-11-03 就已完整
// 暖身，不必再等 4 年才產生訊號。App 端會另外限制「可選擇的回測起始日」
// 不早於 2014-11-03（見 src/App.jsx 的 DEFAULT_RANGE_START），避免使用者
// 選到佔位資料那段、得出失真的權益曲線。

const MARKETS = [
  { key: "TW", sheetMatch: (name) => name.includes("TWN") && name.includes("historical"), anchor: "0050", required: true },
  { key: "US", sheetMatch: (name) => name.includes("VTS") && name.includes("historical"), anchor: "SPY", required: false },
  // NASDAQ 分頁的 SPY 只有收盤價（沒有開盤價），所以錨點改用有開盤價的 QQQ
  { key: "NQ", sheetMatch: (name) => name.includes("NASDAQ") && name.includes("historical"), anchor: "QQQ", required: false },
];

function normalizeHeader(h) {
  return String(h == null ? "" : h)
    .replace(/\s+/g, "")
    .toLowerCase();
}

function excelSerialToISODate(serial) {
  // xlsx 若未啟用 cellDates，日期會是 Excel 序號（1900 日期系統）
  const epoch = Date.UTC(1899, 11, 30); // Excel 序號 0 對應的日期（已修正 1900 閏年 bug）
  const ms = epoch + serial * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function toISODate(raw) {
  if (raw == null) return null;
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === "number") return excelSerialToISODate(raw);
  if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return null;
}

function round(v, digits) {
  const p = 10 ** digits;
  return Math.round(Number(v) * p) / p;
}

function num(v) {
  if (v == null || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function parseMarket(wb, market) {
  const sheetName = wb.SheetNames.find(market.sheetMatch);
  if (!sheetName) {
    const msg = `[parse-xlsx] 找不到市場 ${market.key} 的分頁。現有分頁：${wb.SheetNames.join("、")}`;
    if (market.required) {
      console.error(msg);
      throw new Error("PARSE_FAIL");
    }
    console.warn(msg + "（略過）");
    return null;
  }
  console.log(`[parse-xlsx] ${market.key} 使用分頁：「${sheetName}」`);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null });

  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    if (rows[i] && rows[i].some((c) => normalizeHeader(c) === "date")) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    console.error(`[parse-xlsx] ${market.key}：找不到標題列（需含「Date」欄）。分頁「${sheetName}」前 3 列：`);
    for (let i = 0; i < Math.min(3, rows.length); i++) console.error(`  第${i + 1}列: ${JSON.stringify(rows[i])}`);
    console.error(`[parse-xlsx] 這個檔案共有 ${wb.SheetNames.length} 個分頁：${wb.SheetNames.join("、")}`);
    throw new Error("PARSE_FAIL");
  }

  const header = rows[headerRowIdx].map(normalizeHeader);
  const dateCol = header.indexOf("date");
  const rollCol = header.findIndex((h) => h.includes("rollyield"));
  // VIX 欄：優先找剛好叫「vix」的欄；否則找以 vix 開頭、但不是 VIX9D 的欄（如 "VIX (1 month)"）
  let vixCol = header.indexOf("vix");
  if (vixCol === -1) vixCol = header.findIndex((h) => h.startsWith("vix") && !h.startsWith("vix9d"));

  // 偵測標的：<代號>price / <代號>openprice（排除 dailychange、rolling…等衍生欄位）
  // 同一個代號若在「重複的表頭區」出現第二次，只取第一個。
  const assetCols = new Map(); // ticker -> { close, open }
  header.forEach((h, ci) => {
    const m = /^(.+?)(openprice|open|price|close)$/.exec(h);
    if (!m) return;
    const isOpen = m[2] === "openprice" || m[2] === "open";
    const ticker = m[1];
    if (/daily|rolling|change|beta|correlation|roll/.test(ticker)) return;
    const rec = assetCols.get(ticker) || { close: -1, open: -1 };
    if (!isOpen && rec.close === -1) rec.close = ci;
    if (isOpen && rec.open === -1) rec.open = ci;
    assetCols.set(ticker, rec);
  });
  // 還原原始大小寫代號（標題列去空白後的原文，例如 "00631L"）
  const rawTicker = (ticker) => {
    const ci = assetCols.get(ticker).close;
    const first = String(rows[headerRowIdx][ci] ?? "").trim().split(/\s+/)[0];
    return first && first.toLowerCase() !== ticker ? first : first || ticker.toUpperCase();
  };
  const tickers = [...assetCols.entries()].filter(([, v]) => v.close >= 0).map(([t]) => t);

  const anchorKey = tickers.find((t) => t === market.anchor.toLowerCase());
  if (!anchorKey || assetCols.get(anchorKey).open < 0) {
    console.error(`[parse-xlsx] ${market.key}：錨點標的 ${market.anchor} 缺少收盤價或開盤價欄位。偵測到的標的：${tickers.join(", ")}`);
    throw new Error("PARSE_FAIL");
  }

  // 1) 依錨點標的篩出有效日期列
  const kept = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const dateStr = toISODate(r[dateCol]);
    if (!dateStr) continue;
    const a = assetCols.get(anchorKey);
    if (num(r[a.close]) == null || num(r[a.open]) == null) continue;
    kept.push({ dateStr, r });
  }
  kept.sort((x, y) => (x.dateStr < y.dateStr ? -1 : x.dateStr > y.dateStr ? 1 : 0));
  // VX30 Roll Yield 欄位若開頭有空白（如 NASDAQ 分頁 2004-03 之前），砍掉這些列，
  // 避免空值被當成 0 混進 VIX 百分位的滾動視窗。
  if (rollCol >= 0) {
    const firstRoll = kept.findIndex(({ r }) => num(r[rollCol]) != null);
    if (firstRoll > 0) {
      console.log(`[parse-xlsx] ${market.key}：前 ${firstRoll} 列沒有 Roll Yield（${kept[0].dateStr} ～ ${kept[firstRoll - 1].dateStr}），已略過`);
      kept.splice(0, firstRoll);
    }
  }
  if (kept.length < 30) {
    console.error(`[parse-xlsx] ${market.key}：有效資料列太少（${kept.length} 筆），請確認檔案內容。`);
    throw new Error("PARSE_FAIL");
  }

  // 2) 各標的序列：缺值處理（中間缺值往前補；開頭缺值以第一筆有效值回填）
  const fill = (arr) => {
    let firstIdx = arr.findIndex((v) => v != null);
    if (firstIdx === -1) return null;
    for (let i = 0; i < firstIdx; i++) arr[i] = arr[firstIdx];
    for (let i = firstIdx + 1; i < arr.length; i++) if (arr[i] == null) arr[i] = arr[i - 1];
    return arr;
  };
  const assets = {};
  for (const t of tickers) {
    const c = assetCols.get(t);
    const close = fill(kept.map(({ r }) => num(r[c.close])));
    if (!close) continue;
    const open = c.open >= 0 ? fill(kept.map(({ r }) => num(r[c.open]))) : null;
    const key = rawTicker(t);
    assets[key] = { c: close.map((v) => round(v, 6)), o: open ? open.map((v) => round(v, 6)) : null };
  }

  const out = {
    dates: kept.map((k) => k.dateStr),
    anchor: market.anchor,
    rollYield: kept.map(({ r }) => (rollCol >= 0 && num(r[rollCol]) != null ? round(num(r[rollCol]), 5) : 0)),
    vix: kept.map(({ r }) => (vixCol >= 0 && num(r[vixCol]) != null ? round(num(r[vixCol]), 3) : 0)),
    assets,
  };
  const tradeable = Object.keys(assets).filter((k) => assets[k].o);
  const signalOnly = Object.keys(assets).filter((k) => !assets[k].o);
  console.log(
    `[parse-xlsx] ${market.key}：${out.dates.length} 筆（${out.dates[0]} ～ ${out.dates[out.dates.length - 1]}）；` +
      `可輪動標的：${tradeable.join(", ")}；僅訊號標的：${signalOnly.join(", ") || "無"}`
  );
  return out;
}

function main() {
  if (!fs.existsSync(inputPath)) {
    console.error(`[parse-xlsx] 找不到輸入檔：${inputPath}`);
    process.exit(1);
  }
  const wb = XLSX.read(fs.readFileSync(inputPath), { type: "buffer", cellDates: true });
  const result = {};
  for (const m of MARKETS) {
    let parsed = null;
    try {
      parsed = parseMarket(wb, m);
    } catch (e) {
      if (e.message !== "PARSE_FAIL") throw e;
      if (m.required) process.exit(1);
      // 選填市場（美股）解析失敗：例如資料來源的 Excel 該分頁還是舊版面。略過該市場，不讓整個建置失敗。
      console.warn(`[parse-xlsx] ⚠ 市場 ${m.key} 解析失敗（見上方訊息），已略過；其他市場照常產生。`);
    }
    if (parsed) result[m.key] = parsed;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result));
  console.log(`[parse-xlsx] 已寫入：${path.relative(repoRoot, outputPath)}（市場：${Object.keys(result).join(", ")}）`);
}

main();
