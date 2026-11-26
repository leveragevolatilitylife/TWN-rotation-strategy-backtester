// 自動補上 USD/TWD 最新匯率：讀取資料倉庫（stock-data-collection）data 分支的 Forex_Historical_Data.xlsx，
// 「Data alignment」分頁的 USD/TWD 欄（每個平日自動更新，來源 Yahoo Finance），
// 把「比 src/data/usdtwd.json 最後一個日期更新」的資料補進去。
// - 既有（已提交）的歷史資料一律保留，不覆寫；只往後補。
// - 找不到檔案、分頁、欄位，或數值異常（單日變動 >3%）時：只顯示警告，沿用原檔，不讓部署失敗。
// 用法：node scripts/update-usdtwd.mjs [Forex_Historical_Data.xlsx 路徑] [usdtwd.json 路徑]
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const xlsxPath = path.resolve(root, process.argv[2] || "data/Forex_Historical_Data.xlsx");
const jsonPath = path.resolve(root, process.argv[3] || "src/data/usdtwd.json");
const SHEET = "Data alignment";
const MAX_JUMP = 0.03;

const warn = (m) => console.log(`::warning::USD/TWD 自動更新略過，沿用原檔：${m}`);
try {
  if (!fs.existsSync(xlsxPath)) throw new Error(`找不到 ${path.relative(root, xlsxPath)}`);
  const wb = XLSX.read(fs.readFileSync(xlsxPath), { type: "buffer", cellDates: true, sheets: [SHEET] });
  const ws = wb.Sheets[SHEET];
  if (!ws) throw new Error(`找不到分頁「${SHEET}」`);
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const col = rows[0].findIndex((h) => typeof h === "string" && h.replace(/\s/g, "").toLowerCase() === "usd/twd");
  if (col < 0) throw new Error("找不到 USD/TWD 欄位");
  const pts = [];
  for (let i = 1; i < rows.length; i++) {
    const d = rows[i][0];
    const v = rows[i][col];
    if (!(d instanceof Date) || typeof v !== "number" || !(v > 0)) continue;
    // xlsx 以本機時區解讀日期；用本機年月日組字串（與原檔「無時間」的日期一致）
    const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    pts.push([ds, v]);
  }
  pts.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const doc = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  const last = doc.dates[doc.dates.length - 1];
  const add = pts.filter(([d]) => d > last);
  let prev = doc.close[doc.close.length - 1];
  for (const [d, v] of add) {
    if (Math.abs(v / prev - 1) > MAX_JUMP) throw new Error(`${d} 匯率 ${v} 相對前值 ${prev} 變動超過 ${MAX_JUMP * 100}%`);
    prev = v;
  }
  if (!add.length) console.log(`USD/TWD：已是最新（${last}），資料倉庫最新 ${pts.at(-1)?.[0]}`);
  else {
    doc.dates.push(...add.map((p) => p[0]));
    doc.close.push(...add.map((p) => p[1]));
    fs.writeFileSync(jsonPath, JSON.stringify(doc));
    console.log(`USD/TWD：補上 ${add.length} 筆（${add[0][0]} ~ ${add.at(-1)[0]}），最新 ${add.at(-1)[1]}`);
  }
} catch (e) {
  warn(e.message);
}
