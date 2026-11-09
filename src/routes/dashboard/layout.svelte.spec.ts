import { createRawSnippet } from 'svelte';
import { page } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import DashboardLayout from './+layout.svelte';
import '../layout.css';

vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn(), goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/state', () => ({
	page: {
		url: new URL('http://localhost/dashboard'),
		data: { googleHealthEnabled: false, user: { id: 'qa', name: 'QA', email: 'qa@example.test' } }
	}
}));
vi.mock('#lib/remote/health.remote.js', () => ({
	getCategories: () => ({ current: [{ category: 'body', count: 1 }], ready: true })
}));

afterEach(async () => {
	setLocale('en', { reload: false });
	await page.viewport(1280, 800);
});

describe('dashboard header at tablet widths', () => {
	it.each([
		{ locale: 'en', width: 320 },
		{ locale: 'es', width: 320 },
		{ locale: 'en', width: 768 },
		{ locale: 'es', width: 768 },
		{ locale: 'en', width: 1024 },
		{ locale: 'es', width: 1024 },
		{ locale: 'en', width: 1280 },
		{ locale: 'es', width: 1280 }
	] as const)('keeps controls reachable in $locale at $width px', async ({ locale, width }) => {
		setLocale(locale, { reload: false });
		await page.viewport(width, 900);
		render(DashboardLayout, { children: createRawSnippet(() => ({ render: () => '<p>QA</p>' })) });
		for (const name of [
			locale === 'en' ? 'Account' : 'Cuenta',
			locale === 'en' ? 'Search or jump to…' : 'Buscar o ir a…'
		]) {
			const control = page.getByRole('button', { name, exact: true });
			await expect.element(control).toBeVisible();
			const box = control.element().getBoundingClientRect();
			expect(box.left).toBeGreaterThanOrEqual(0);
			expect(box.right).toBeLessThanOrEqual(window.innerWidth);
		}
		if (width < 1024) {
			await expect
				.element(
					page.getByRole('button', {
						name: locale === 'en' ? 'Open navigation' : 'Abrir navegación'
					})
				)
				.toBeVisible();
		} else {
			await expect
				.element(
					page.getByRole('navigation', {
						name: locale === 'en' ? 'Main navigation' : 'Navegación principal'
					})
				)
				.toBeVisible();
		}
	});
});
