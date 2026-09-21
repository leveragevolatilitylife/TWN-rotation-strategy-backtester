# 台股輪動策略回測工作台 v2

VIX Roll Yield／0050 均線乖離率輪動邏輯的互動式回測工具，內建「台股波動率輪換策略儀表板」每日追蹤的 5 組預設策略（MA Rotation、MA Rotation II、VIX Rotation+BTD、MARS+VRS Hybrid、MARS+VRS Hybrid II），可自由調參數、並排比較、分析 IC/IR、PBO 過擬合機率、DSR 等指標。

這是可以部署到 GitHub Pages 的完整版本；資料更新流程見下方「更新回測資料」。

## 本機開發

```bash
npm install
npm run dev
```

會啟動本機開發伺服器（預設 http://localhost:5173），修改 `src/App.jsx` 會即時熱更新。

## 建置與預覽

```bash
npm run build      # 輸出到 dist/
npm run preview    # 本機預覽建置後的成品
```

## 部署到 GitHub Pages（第一次設定）

1. 在 GitHub 建立一個新的空 repository（public 或 private 皆可，private 要用 Pages 需付費方案）。
2. 把這個資料夾的內容全部 push 上去：

   ```bash
   cd twn-rotation-backtester
   git init
   git add .
   git commit -m "Initial commit: TWN rotation backtester v2"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo>.git
   git push -u origin main
   ```

3. 到 repo 的 **Settings → Pages**，「Build and deployment → Source」選擇 **GitHub Actions**（不是 "Deploy from a branch"）。
4. 到 **Actions** 分頁確認 `Build and deploy to GitHub Pages` 這個 workflow 有跑起來（push 到 `main` 會自動觸發）。跑完後，網址會顯示在 Settings → Pages 頁面上方，格式通常是：

   ```
   https://<your-username>.github.io/<your-repo>/
   ```

5. 之後每次 push 到 `main`，網站都會自動重新建置＋部署，不需要再手動操作。

> 如果您的預設分支不是 `main`（例如是 `master`），要記得把 `.github/workflows/deploy.yml` 裡 `branches: [main]` 改成對應的分支名稱。

## 更新回測資料（上傳新版 Excel）

1. 用新版的 `Stock_data_collection.xlsx` **直接覆蓋** `data/Stock_data_collection.xlsx` 這個檔案。
2. `git add data/Stock_data_collection.xlsx && git commit -m "Update stock data" && git push`。
3. Push 上去之後，GitHub Actions 會自動：
   - 讀取新的 `data/Stock_data_collection.xlsx`
   - 執行 `scripts/parse-xlsx.mjs`，重新產生 `src/data/twn_data.json`
   - 重新建置整個網站並部署

   **您完全不需要手動跑指令或改程式碼**，push 上去等 Actions 跑完（通常1-2分鐘）就會自動更新。也可以直接在 GitHub 網頁上，進到 `data/` 資料夾點 `Stock_data_collection.xlsx` 旁邊的鉛筆／上傳按鈕直接換檔，一樣會觸發自動部署。

4. 若想在 push 之前，先在本機確認新檔案解析沒問題，可以執行：

   ```bash
   npm run parse-data
   ```

   這會直接重新產生 `src/data/twn_data.json`，可以打開來看看筆數、起訖日期對不對，再一起 commit push。

**欄位需求**：xlsx 需含「TWN historical data」分頁，且欄位（標題列）需包含：`Date`、`0050 price`、`0050 open price`、`00631L price`、`00631L open price`、`00635U price`、`00635U open price`；`VX30:VIX Roll Yield`與`VIX`為選填（缺少的話 VIX Rotation 相關策略的訊號會失真，但不影響其他功能）。

**資料範圍與「可選擇的回測起始日」是兩件事**：`scripts/parse-xlsx.mjs` 現在保留檔案裡的完整歷史（本檔案回溯至 2007 年），刻意不做日期下限篩選——因為 VX30:VIX Roll Yield 欄位在 2014-11-03 之前就有真實歷史資料，保留它可以讓 VIX 滾動視窗（預設 1000 個交易日）從 2014-11-03 就已經完整暖身，不用再等 4 年才開始產生訊號。但 00631L/00635U/0050 等價格欄位在 2014-11-03（各 ETF 真正上市）之前是原始檔案用常數回填的佔位資料，不是真實市場資料，所以 `src/App.jsx` 裡的 `DEFAULT_RANGE_START` 常數把「可選擇的回測起始日」鎖定在 2014-11-03——UI 上的日期選擇器不論資料集本身多早，都無法選到更早的日期，避免用到佔位資料段落、得出失真的權益曲線。如果之後要調整這個下限，只需要改 `src/App.jsx` 裡的 `DEFAULT_RANGE_START` 常數即可，`scripts/parse-xlsx.mjs` 不需要跟著改（它本來就保留全部歷史）。

> 網站本身沒有瀏覽器端「上傳更新資料」的功能——所有資料更新都是透過上面「覆蓋 xlsx + push」這個流程統一處理，確保所有訪客看到的都是同一份、來自 repo 的資料。

## 專案結構

```
twn-rotation-backtester/
├── .github/workflows/deploy.yml   # push 到 main 時自動建置＋部署到 GitHub Pages
├── data/
│   └── Stock_data_collection.xlsx # 資料來源（覆蓋這個檔案＝更新回測資料）
├── scripts/
│   └── parse-xlsx.mjs             # 把 xlsx 轉成 src/data/twn_data.json 的 Node 腳本
├── src/
│   ├── data/twn_data.json         # App 實際 import 的資料（由 parse-xlsx.mjs 產生，不需手動編輯）
│   ├── App.jsx                    # 主要元件（策略引擎＋所有 UI）
│   └── main.jsx                   # Vite/React 進入點
├── index.html
├── package.json
└── vite.config.js
```

## 5 組預設策略的參數來源

由 `00631L_00635U_MARS_VRS_Hybrid.xlsx` 的公式逐一比對確認，非憑印象設定：

| 策略 | 均線邏輯 | VIX邏輯 | 合併方式 |
|---|---|---|---|
| MA Rotation | 60日均線（收盤價），乖離<20%→多 | — | — |
| MA Rotation II | 60日均線（當日開盤價+前59日收盤），乖離<20%→多 | — | — |
| VIX Rotation+BTD (R4Y28_4Y.5) | — | 滾動1000日，高分位28%/低分位1%/極低分位0.5% | — |
| MARS+VRS Hybrid | MA Rotation II | 同左 VIX | HOLD（訊號不同→維持前日） |
| MARS+VRS Hybrid II | MA Rotation II | 同左 VIX | OR（任一多方即多） |

**已知的成本模型差異**：原始試算表對每次輪動只合併扣一次手續費（折扣費率 0.1425%×0.6=0.0855%）＋0.1%證交稅；本工具對賣出、買進各自計一次手續費（較貼近實際下單機制，您真的會分別付兩筆手續費）。預設手續費率為標準（未折扣）費率 0.1425%，如需更貼近原始試算表的結果，可在左側把手續費率改成 0.0855% 參考，但仍會因為計費次數不同而與原始試算表略有落差，這是方法論差異，不是計算錯誤。

## 與 Claude 對話版本的關係

這個 repo 版本的 `src/App.jsx` 邏輯與在 Claude 對話中產生的 `twn_rotation_backtester_v2.jsx` 完全相同（同一份策略引擎程式碼），差別只在於：資料來源從「內嵌在檔案裡的固定陣列」改成「從 `src/data/twn_data.json` import」，讓資料更新可以透過上面的 GitHub 流程自動化，不用每次都重新產生一份新的內嵌資料檔。
