import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base 用相對路徑，不論部署在 GitHub Pages 的根目錄或專案子路徑
// （https://<user>.github.io/ 或 https://<user>.github.io/<repo>/）都能正常運作，
// 不需要因為 repo 名稱不同而手動修改這裡。
export default defineConfig({
  plugins: [react()],
  base: "./",
});
