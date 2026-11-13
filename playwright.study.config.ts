import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e', testMatch: 'phrase-study.spec.ts', timeout: 45_000, workers: 1,
  use: { ...devices['Desktop Chrome'], channel: 'chrome', baseURL: 'http://127.0.0.1:4185/silent-speech/' },
  webServer: { command: 'npm run build && node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4185 --strictPort',
    url: 'http://127.0.0.1:4185/silent-speech/study.html', reuseExistingServer: false, timeout: 60_000 },
});
