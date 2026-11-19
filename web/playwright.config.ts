import { defineConfig, devices } from "@playwright/test";

// Isolated test stack on its own ports (8001 / 3001) so tests never touch a live dev stack on 8000 / 3000:
// FastAPI gateway in fake mode (no Ollama / arXiv) + a production build of the Next.js app.
const API = "http://localhost:8001";
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { baseURL: "http://localhost:3001", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "uv run --no-sync uvicorn co_scientist.api:app --port 8001",
      cwd: "..",
      url: `${API}/health`,
      env: { CS_FAKE_LLM: "1", CS_CORS_ORIGINS: "http://localhost:3001" },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: "npx next build && npx next start -p 3001",
      url: "http://localhost:3001",
      env: { NEXT_PUBLIC_API_URL: API },
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
});
