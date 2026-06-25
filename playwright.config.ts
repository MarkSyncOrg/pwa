import { defineConfig, devices } from '@playwright/test';

// E2E runs against the built app served by `vite preview`, so the real service
// worker, manifest and bundle are exercised. The xBrowserSync API is mocked at
// the network layer inside each test (see e2e/sync.spec.ts).
const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
