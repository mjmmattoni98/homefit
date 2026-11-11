import { defineConfig } from '@playwright/test';

export default defineConfig({
	testMatch: '**/*.e2e.ts',
	timeout: 60_000,
	workers: 1,
	use: { baseURL: 'http://127.0.0.1:3300', locale: 'en-US', trace: 'retain-on-failure' }
});
