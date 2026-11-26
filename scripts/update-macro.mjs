// 自動更新總經資料：FOMC 利率決議、美國 CPI／PCE／核心 PCE 年增率（來源：FRED API）
//
// 用法（部署流程在建置前執行）：FRED_API_KEY=xxxx node scripts/update-macro.mjs
// - 沒有設定 FRED_API_KEY、或任何一步抓取／驗證失敗：只顯示警告，沿用 repo 內已提交的 JSON（不讓部署失敗）。
// - 只更新建置工作目錄內的 JSON，不會 commit。
// - 通膨：只重算最近 MONTHS_BACK 個月，並把公布日改成 FRED（ALFRED）記錄的「首次公布日」；更早的歷史維持原檔不動。
// - FOMC：只補上「最後一筆已記錄決議」之後的新變動；日期以既有決議對照 FRED 目標利率變動日的偏移量校正，對不上就整段放棄。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "data");
const API = "https://api.stlouisfed.org/fred/series/observations";
const MONTHS_BACK = 18;

/* ---------- 日期小工具（一律用 UTC，避免時區偏移） ---------- */
const toUTC = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
const DAY = 86400000;
const monthKey = (s) => s.slice(0, 7);
const shiftMonth = (key, k) => {
  const y = +key.slice(0, 4);
  const m = +key.slice(5, 7) - 1 + k;
  return `${y + Math.floor(m / 12)}-${String(((m % 12) + 12) % 12 + 1).padStart(2, "0")}`;
};
const monthEnd = (key) => fmt(Date.UTC(+key.slice(0, 4), +key.slice(5, 7), 0));

/* ---------- 通膨：年增率與公布日 ---------- */
// latest: [{date, value}]（最新修正版指數，date=該月 1 日）；initial: [{date, realtime_start}]（首次公布日）
export function computeReleases({ latest, initial, existing, fallbackDay, decimals, monthsBack = MONTHS_BACK }) {
  const idx = new Map(latest.filter((o) => o.value != null).map((o) => [monthKey(o.date), o.value]));
  const first = new Map(initial.map((o) => [monthKey(o.date), o.realtime_start]));
  const months = [...idx.keys()].sort();
  const computable = months.filter((m) => idx.has(shiftMonth(m, -12)));
  if (!computable.length) throw new Error("沒有可計算年增率的月份");
  const target = computable.slice(-monthsBack);
  const firstTarget = target[0];
  const fresh = target.map((m) => {
    const v = +((idx.get(m) / idx.get(shiftMonth(m, -12)) - 1) * 100).toFixed(decimals);
    const nxt = shiftMonth(m, 1);
    const fb = `${nxt}-${String(fallbackDay).padStart(2, "0")}`;
    const rs = first.get(m);
    // 首次公布日必須落在該月月底之後 75 天內，否則（ALFRED 早期資料的占位日期等）改用慣例日
    const ok = rs && rs > monthEnd(m) && toUTC(rs) <= toUTC(monthEnd(m)) + 75 * DAY;
    return [ok ? rs : fb, v];
  });
  const kept = existing.filter(([d]) => shiftMonth(monthKey(d), -1) < firstTarget); // 既有項目的所屬月份＝公布月份的前一個月
  return [...kept, ...fresh].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/* ---------- FOMC：由目標利率區間日資料偵測新決議 ---------- */
export function detectDecisions({ upper, lower, existing }) {
  const lo = new Map(lower.filter((o) => o.value != null).map((o) => [o.date, o.value]));
  const daily = upper.filter((o) => o.value != null && lo.has(o.date)).map((o) => ({ date: o.date, mid: (o.value + lo.get(o.date)) / 2 }));
  const changes = [];
  for (let i = 1; i < daily.length; i++) if (Math.abs(daily[i].mid - daily[i - 1].mid) > 1e-9) changes.push(daily[i]);
  // 以 2015-12 之後的既有決議校正「FRED 變動日 − 決議日」的偏移天數
  const ref = existing.filter(([d]) => d >= "2015-12-01" && d <= daily.at(-1).date);
  const offs = [];
  let matched = 0;
  for (const [d, mid] of ref) {
    const c = changes.find((x) => Math.abs(toUTC(x.date) - toUTC(d)) <= 3 * DAY && Math.abs(x.mid - mid) < 1e-6);
    if (c) {
      matched++;
      offs.push(Math.round((toUTC(c.date) - toUTC(d)) / DAY));
    }
  }
  if (!ref.length || matched / ref.length < 0.8) throw new Error(`既有決議只對上 ${matched}/${ref.length} 筆，放棄 FOMC 更新`);
  const cnt = {};
  offs.forEach((o) => (cnt[o] = (cnt[o] || 0) + 1));
  const off = +Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
  const lastDate = existing.at(-1)[0];
  const added = changes
    .map((c) => [fmt(toUTC(c.date) - off * DAY), c.mid])
    .filter(([d]) => d > lastDate);
  return { added, offset: off, matched, total: ref.length };
}

/* ---------- FRED 抓取 ---------- */
async function fred(seriesId, key, extra = "") {
  const url = `${API}?series_id=${seriesId}&api_key=${key}&file_type=json${extra}`;
  let lastErr;
  for (let t = 0; t < 3; t++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      return j.observations;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (t + 1)));
    }
  }
  throw new Error(`${seriesId}：${lastErr.message}`);
}
const num = (o) => ({ ...o, value: o.value === "." || o.value == null ? null : Number(o.value) });

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
const writeJson = (f, o) => fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(o, null, 2));

async function main() {
  const key = (process.env.FRED_API_KEY || "").trim();
  if (!key) {
    console.log("::warning::未設定 FRED_API_KEY，總經資料沿用 repo 內已提交的檔案");
    return;
  }
  const specs = [
    { file: "us_cpi.json", id: "CPIAUCNS", day: 15, dec: 1 },
    { file: "us_pce.json", id: "PCEPI", day: 28, dec: 2 },
    { file: "us_core_pce.json", id: "PCEPILFE", day: 28, dec: 2 },
  ];
  for (const s of specs) {
    try {
      const start = `&observation_start=${shiftMonth(new Date().toISOString().slice(0, 7), -(MONTHS_BACK + 14))}-01`;
      const latest = (await fred(s.id, key, start)).map(num);
      let initial = [];
      try {
        initial = await fred(s.id, key, `${start}&realtime_start=1776-07-04&realtime_end=9999-12-31&output_type=4`);
      } catch (e) {
        console.log(`::warning::${s.id} 首次公布日抓取失敗，公布日改用慣例日（${e.message}）`);
      }
      const doc = readJson(s.file);
      const before = doc.releases.at(-1);
      doc.releases = computeReleases({ latest, initial, existing: doc.releases, fallbackDay: s.day, decimals: s.dec });
      writeJson(s.file, doc);
      console.log(`${s.file}：最新 ${before.join("=")} → ${doc.releases.at(-1).join("=")}（共 ${doc.releases.length} 筆）`);
    } catch (e) {
      console.log(`::warning::${s.file} 更新失敗，沿用原檔：${e.message}`);
    }
  }
  try {
    const st = "&observation_start=2015-11-01";
    const upper = (await fred("DFEDTARU", key, st)).map(num);
    const lower = (await fred("DFEDTARL", key, st)).map(num);
    const doc = readJson("fed_rates.json");
    const r = detectDecisions({ upper, lower, existing: doc.decisions });
    if (r.added.length) {
      doc.decisions = [...doc.decisions, ...r.added];
      writeJson("fed_rates.json", doc);
    }
    console.log(`fed_rates.json：對照 ${r.matched}/${r.total} 筆，日期偏移 ${r.offset} 天，新增 ${r.added.length} 筆決議 ${JSON.stringify(r.added)}`);
  } catch (e) {
    console.log(`::warning::fed_rates.json 更新失敗，沿用原檔：${e.message}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.log(`::warning::總經資料更新發生未預期錯誤，沿用原檔：${e.message}`);
  });
}
