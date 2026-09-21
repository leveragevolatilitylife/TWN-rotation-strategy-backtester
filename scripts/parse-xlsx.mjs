// 讀取 data/Stock_data_collection.xlsx 的「TWN historical data」分頁，
// 轉換為 src/data/twn_data.json 供前端直接 import 使用。
// 用法：node scripts/parse-xlsx.mjs [輸入檔路徑] [輸出檔路徑]
// 預設：node scripts/parse-xlsx.mjs data/Stock_data_collection.xlsx src/data/twn_data.json
//
// 欄位規則與前端「上傳更新資料」的瀏覽器端解析邏輯保持一致：
// 必要欄位（正規化後比對）：date, 0050price, 0050openprice,
//   00631lprice, 00631lopenprice, 00635uprice, 00635uopenprice
// 選填欄位：任何包含 "rollyield" 的欄位（VX30:VIX Roll Yield）、"vix"（VIX）

import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const inputPath = path.resolve(repoRoot, process.argv[2] || "data/Stock_data_collection.xlsx");
const outputPath = path.resolve(repoRoot, process.argv[3] || "src/data/twn_data.json");

// 注意：這裡刻意不對日期設下限。00631L/00635U/0050 等價格欄位在 2014-11-03
// 之前於原始檔案中是用常數回填的佔位資料（ETF尚未真正存在），但 VX30:VIX
// Roll Yield 欄位在此之前有真實歷史資料（本檔案回溯至 2007 年），保留完整
// 歷史讓 App 端的 VIX 滾動視窗（預設 1000 個交易日）從 2014-11-03 就已完整
// 暖身，不必再等 4 年才產生訊號。App 端會另外限制「可選擇的回測起始日」
// 不早於 2014-11-03（見 src/App.jsx 的 DEFAULT_RANGE_START），避免使用者
// 選到佔位資料那段、得出失真的權益曲線。

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

function main() {
  if (!fs.existsSync(inputPath)) {
    console.error(`[parse-xlsx] 找不到輸入檔：${inputPath}`);
    process.exit(1);
  }

  const buf = fs.readFileSync(inputPath);
  const wb = XLSX.read(buf, { type: "buffer", cellDates: true });

  let sheetName = wb.SheetNames.find((s) => s.includes("TWN") && s.includes("historical"));
  if (!sheetName) sheetName = wb.SheetNames.find((s) => normalizeHeader(s).includes("historicaldata"));
  if (!sheetName) sheetName = wb.SheetNames[0];
  console.log(`[parse-xlsx] 使用分頁：「${sheetName}」`);

  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });

  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 6); i++) {
    if (rows[i] && rows[i].some((c) => normalizeHeader(c) === "date")) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    console.error('[parse-xlsx] 找不到標題列（需含「Date」欄）。');
    console.error(`[parse-xlsx] 這個檔案裡總共有 ${wb.SheetNames.length} 個分頁：${wb.SheetNames.join("、")}`);
    console.error(`[parse-xlsx] 目前選到的分頁「${sheetName}」前 3 列內容：`);
    for (let i = 0; i < Math.min(3, rows.length); i++) {
      console.error(`  第${i + 1}列: ${JSON.stringify(rows[i])}`);
    }
    console.error(
      "[parse-xlsx] 若分頁數量與預期不符（例如應該有多個分頁卻只看到 1 個、或看到的是空白/亂碼），" +
        "很可能是這個 xlsx 檔案在 Git 儲存過程中被當成文字檔做了換行轉換而損毀。" +
        "請確認 repo 根目錄有 .gitattributes 且包含「*.xlsx binary」，" +
        "並用「git rm --cached <檔案路徑> && git add <檔案路徑> && git commit」重新以二進位方式提交該檔案後再 push。"
    );
    process.exit(1);
  }

  const header = rows[headerRowIdx].map(normalizeHeader);
  const colIdx = {
    date: header.indexOf("date"),
    p0050: header.indexOf("0050price"),
    o0050: header.indexOf("0050openprice"),
    p631L: header.indexOf("00631lprice"),
    o631L: header.indexOf("00631lopenprice"),
    p635U: header.indexOf("00635uprice"),
    o635U: header.indexOf("00635uopenprice"),
    rollYield: header.findIndex((h) => h.includes("rollyield")),
    vix: header.indexOf("vix"),
  };
  const requiredKeys = ["date", "p0050", "o0050", "p631L", "o631L", "p635U", "o635U"];
  const missing = requiredKeys.filter((k) => colIdx[k] === -1);
  if (missing.length > 0) {
    console.error(`[parse-xlsx] 缺少必要欄位（含開盤價）：${missing.join(", ")}`);
    process.exit(1);
  }

  const parsed = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const dateStr = toISODate(r[colIdx.date]);
    if (!dateStr) continue;
    const c0050 = r[colIdx.p0050], op0050 = r[colIdx.o0050];
    const c631L = r[colIdx.p631L], op631L = r[colIdx.o631L];
    const c635U = r[colIdx.p635U], op635U = r[colIdx.o635U];
    if ([c0050, op0050, c631L, op631L, c635U, op635U].some((v) => v == null)) continue;
    const rollYield = colIdx.rollYield >= 0 ? r[colIdx.rollYield] : null;
    const vix = colIdx.vix >= 0 ? r[colIdx.vix] : null;
    parsed.push([
      dateStr,
      round(c0050, 3), round(op0050, 3),
      round(c631L, 3), round(op631L, 3),
      round(c635U, 3), round(op635U, 3),
      rollYield == null ? 0 : round(rollYield, 5),
      vix == null ? 0 : round(vix, 3),
    ]);
  }

  if (parsed.length < 30) {
    console.error(`[parse-xlsx] 解析後的有效資料列太少（${parsed.length} 筆），請確認檔案內容與欄位格式。`);
    process.exit(1);
  }

  parsed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(parsed));

  console.log(`[parse-xlsx] 完成：共 ${parsed.length} 筆交易日資料（${parsed[0][0]} ～ ${parsed[parsed.length - 1][0]}）`);
  console.log(`[parse-xlsx] 已寫入：${path.relative(repoRoot, outputPath)}`);
}

function round(v, digits) {
  const p = 10 ** digits;
  return Math.round(Number(v) * p) / p;
}

main();
