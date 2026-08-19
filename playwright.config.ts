import { defineConfig, devices } from '@playwright/test';

// E2E runs against the built app served by `vite preview`, so the real service
// worker, manifest and bundle are exercised. The xBrowserSync API is mocked at
// the network layer inside each test (see e2e/sync.spec.ts).
const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  retries: 0,
  // `list` is the readable stream in the Actions log; `html` is what the workflow
  // uploads as an artifact, which is the only way a failure here is diagnosable without
  // reproducing it locally. Both output paths are gitignored.
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Not `on-first-retry`: retries are 0, so that setting captured a trace on exactly
    // no runs. A failure is the case worth having one for.
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm build && pnpm preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
