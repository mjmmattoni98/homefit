import { page } from 'vitest/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { setLocale } from '#lib/paraglide/runtime.js';
import SiteHeader from './SiteHeader.svelte';
import '../../routes/layout.css';

vi.mock('$app/state', () => ({ page: { data: { user: null, signupEnabled: true } } }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path }));

afterEach(async () => {
	setLocale('en', { reload: false });
	await page.viewport(1280, 800);
});

describe('public header on narrow screens', () => {
	it.each([320, 375])('keeps Spanish authentication links inside a %ipx screen', async (width) => {
		await page.viewport(width, 667);
		setLocale('es', { reload: false });
		render(SiteHeader);
		await expect.element(page.getByRole('link', { name: 'Crear cuenta' })).toBeVisible();
		await expect.element(page.getByRole('link', { name: 'Iniciar sesión' })).toBeVisible();
		await expect
			.poll(() => document.documentElement.scrollWidth)
			.toBeLessThanOrEqual(window.innerWidth);
		for (const name of ['Crear cuenta', 'Iniciar sesión']) {
			const bounds = page.getByRole('link', { name }).element().getBoundingClientRect();
			expect(bounds.left).toBeGreaterThanOrEqual(0);
			expect(bounds.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
		}
		await page.getByRole('button', { name: 'Idioma', exact: true }).click();
		await expect.element(page.getByRole('menuitemradio', { name: 'English' })).toBeVisible();
	});
});
