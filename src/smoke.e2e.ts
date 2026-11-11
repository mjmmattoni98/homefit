import { test, expect } from '@playwright/test';
import { CSV_DELETE_CONFIRMATION } from './lib/csv/confirmation';

for (const theme of ['light', 'dark'] as const) {
	test(`synthetic CSV lifecycle (${theme})`, async ({ page }) => {
		const errors: string[] = [];
		page.on('pageerror', (error) => errors.push(error.message));
		await page.addInitScript((mode) => {
			localStorage.setItem('mode-watcher-mode', mode);
			window.addEventListener('securitypolicyviolation', (event) => {
				console.error(`CSP violation: ${event.violatedDirective}`);
			});
		}, theme);
		page.on('console', (message) => {
			if (message.text().includes('CSP violation:')) errors.push(message.text());
		});
		const email = `smoke-${theme}-${crypto.randomUUID()}@example.com`;
		const response = await page.goto('/sign-up');
		const policy = response?.headers()['content-security-policy'] ?? '';
		expect(policy).toMatch(/script-src[^;]*'nonce-/);
		expect(
			policy.split(';').find((directive) => directive.trim().startsWith('script-src'))
		).not.toContain('unsafe-inline');
		expect(response?.headers()['strict-transport-security']).toBeUndefined();
		await page.getByLabel('Name', { exact: true }).fill('Synthetic Owner');
		await page.getByLabel('Email', { exact: true }).fill(email);
		await page.getByLabel('Password', { exact: true }).fill('synthetic-password-123');
		await page.getByRole('button', { name: 'Sign up', exact: true }).click();
		await expect(page).toHaveURL(/dashboard/);
		await expect(page.locator('html')).toHaveClass(theme === 'dark' ? /dark/ : /^(?!.*dark)/);
		await page.goto('/dashboard/import');
		const themeColor = page.locator('meta[name="theme-color"]');
		const colors = { light: '#f5f7f9', dark: '#121721' };
		await expect(themeColor).toHaveCount(1);
		await expect(themeColor).toHaveAttribute('content', colors[theme]);
		await page.getByRole('button', { name: 'Toggle dark mode' }).click();
		await expect(themeColor).toHaveAttribute(
			'content',
			colors[theme === 'dark' ? 'light' : 'dark']
		);
		await page.getByRole('button', { name: 'Toggle dark mode' }).click();
		await expect(themeColor).toHaveAttribute('content', colors[theme]);
		await expect(page.getByTestId('export-zone')).toContainText('Your first import will save');
		const hevyHeader =
			'title,start_time,end_time,description,exercise_title,set_index,set_type,weight_kg,reps';
		const day = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
		const nextDay = new Date(Date.parse(day) + 86400_000).toISOString().slice(0, 10);
		const stamp = new Intl.DateTimeFormat('en-GB', {
			day: '2-digit',
			month: 'short',
			year: 'numeric',
			timeZone: 'UTC'
		}).format(new Date(day));
		const hevy = (weight: number, title = 'Synthetic Workout') =>
			`${hevyHeader}\n"${title}","${stamp}, 18:00","${stamp}, 19:00",Synthetic,"Synthetic Bench",0,normal,${weight},8`;
		const sleep = `Went to bed;Woke up;Sleep quality;Time in bed (seconds);Time asleep (seconds);Asleep after (seconds);Did snore;Snore time (seconds);Notes\n${day} 23:00:00;${nextDay} 07:00:00;80%;28800;25200;600;false;0;Synthetic`;
		async function importFile(source: 'Hevy' | 'Sleep Cycle', content: string, result: string) {
			const card = page
				.locator('div.grid')
				.filter({ has: page.getByRole('heading', { name: source, exact: true }) });
			await card.locator('input[type=file]').setInputFiles({
				name: 'synthetic.csv',
				mimeType: 'text/csv',
				buffer: Buffer.from(content)
			});
			await card.getByRole('button', { name: 'Import', exact: true }).click();
			await expect(card.getByRole('status')).toHaveText(result);
		}
		await importFile('Hevy', hevy(60), 'Imported 1, updated 0, skipped 0');
		await importFile('Sleep Cycle', sleep, 'Imported 1, updated 0, skipped 0');
		await importFile('Hevy', hevy(60), 'Imported 0, updated 0, skipped 1');
		await importFile('Sleep Cycle', sleep, 'Imported 0, updated 0, skipped 1');
		await importFile('Hevy', hevy(70, 'Renamed Workout'), 'Imported 0, updated 1, skipped 0');
		const hevyCard = page
			.locator('div.grid')
			.filter({ has: page.getByRole('heading', { name: 'Hevy', exact: true }) });
		const ambiguousMessage =
			'These Hevy sessions cannot be matched safely. Delete the imported Hevy data on this page, then import the full export again.';
		await hevyCard.locator('input[type=file]').setInputFiles({
			name: 'ambiguous.csv',
			mimeType: 'text/csv',
			buffer: Buffer.from(hevy(80, 'B') + '\n' + hevy(90, 'C').split('\n')[1])
		});
		await hevyCard.getByRole('button', { name: 'Import', exact: true }).click();
		await expect(page.getByText(ambiguousMessage, { exact: true })).toBeVisible();
		await expect(
			page.getByText('The import could not finish. Please try again.', { exact: true })
		).toHaveCount(0);
		await page.goto('/dashboard');
		await expect(page.getByText('Renamed Workout', { exact: true })).toHaveCount(1);
		await expect(
			page.getByRole('region', { name: 'Sleep & training', exact: true }).locator('svg').first()
		).toBeVisible();
		await page.goto('/dashboard/exercises');
		await expect(page.getByRole('heading', { name: 'Synthetic Bench', exact: true })).toBeVisible();
		await expect(page.getByRole('region', { name: 'Synthetic Bench', exact: true })).toContainText(
			'560'
		);
		await expect(
			page.getByRole('region', { name: 'Estimated 1RM', exact: true }).locator('svg').first()
		).toBeVisible();
		await page.goto('/dashboard/import');
		// The page and both dialogs at desktop and phone sizes.
		for (const width of [1280, 390]) {
			await page.setViewportSize({ width, height: 900 });
			await expect(page.getByTestId('export-zone')).toContainText(
				'Times in export files are read as'
			);
			const sleepCard = page
				.locator('div.grid')
				.filter({ has: page.getByRole('heading', { name: 'Sleep Cycle', exact: true }) });
			await sleepCard
				.getByRole('button', { name: 'Delete imported data' })
				.scrollIntoViewIfNeeded();
			await expect(
				sleepCard.getByRole('button', { name: 'Delete imported data' })
			).toBeInViewport();
			await page.getByRole('button', { name: 'Change', exact: true }).click();
			const dialog = page.getByRole('dialog');
			await expect(dialog.getByRole('combobox')).toBeFocused();
			await expect(dialog.getByRole('combobox')).toContainText('UTC');
			await page.keyboard.press('Escape');
			await expect(dialog).toHaveCount(0);
			await sleepCard.getByRole('button', { name: 'Delete imported data' }).click();
			await expect(page.getByRole('alertdialog')).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(page.getByRole('alertdialog').getByLabel('Confirmation')).toBeFocused();
			await page
				.getByRole('alertdialog')
				.getByRole('button', { name: 'Cancel', exact: true })
				.click();
			await expect(page.getByRole('alertdialog')).toHaveCount(0);
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
				true
			);
		}
		// Saving clears both parsed CSVs; the picker works with the keyboard too.
		for (const source of ['Hevy', 'Sleep Cycle']) {
			await page.getByLabel(source, { exact: true }).setInputFiles({
				name: 'parsed.csv',
				mimeType: 'text/csv',
				buffer: Buffer.from(source === 'Hevy' ? hevy(70, 'Renamed Workout') : sleep)
			});
		}
		await expect(page.getByRole('button', { name: 'Import', exact: true }).first()).toBeEnabled();
		await expect(page.getByRole('button', { name: 'Import', exact: true }).last()).toBeEnabled();
		await page.getByRole('button', { name: 'Change', exact: true }).click();
		await page.getByRole('dialog').getByRole('combobox').selectOption('Pacific/Honolulu');
		await page.getByRole('dialog').getByRole('combobox').press('Tab');
		await expect(
			page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true })
		).toBeFocused();
		await page.keyboard.press('Tab');
		await page.keyboard.press('Enter');
		await expect(page.getByRole('dialog')).not.toBeVisible();
		await expect(page.getByTestId('export-zone')).toContainText('Pacific/Honolulu');
		for (const button of await page.getByRole('button', { name: 'Import', exact: true }).all())
			await expect(button).toBeDisabled();
		await expect(page.getByText('parsed.csv', { exact: true })).toHaveCount(0);
		await page.reload();
		await expect(page.getByTestId('export-zone')).toContainText('Pacific/Honolulu');
		for (const source of ['Hevy', 'Sleep Cycle'] as const) {
			const card = page
				.locator('div.grid')
				.filter({ has: page.getByRole('heading', { name: source, exact: true }) });
			await card.getByRole('button', { name: 'Delete imported data' }).click();
			const dialog = page.getByRole('alertdialog');
			await dialog
				.getByLabel('Confirmation')
				.fill(CSV_DELETE_CONFIRMATION[source === 'Hevy' ? 'hevy' : 'sleep']);
			await dialog.getByRole('button', { name: 'Delete imported data' }).click();
			await expect(dialog).toHaveCount(0);
		}
		await page.goto('/dashboard');
		await expect(page.getByText('Renamed Workout', { exact: true })).toHaveCount(0);
		await page.goto('/dashboard/exercises');
		await expect(page.getByRole('heading', { name: 'Synthetic Bench', exact: true })).toHaveCount(
			0
		);
		await page.getByRole('button', { name: 'Account', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Sign out' }).click();
		await expect(page).toHaveURL('http://127.0.0.1:3300/');
		await page.goto('/sign-in');
		await page.getByLabel('Email', { exact: true }).fill(email);
		await page.getByLabel('Password', { exact: true }).fill('synthetic-password-123');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await expect(page).toHaveURL(/dashboard/);
		expect(errors).toEqual([]);
	});
}

for (const theme of ['light', 'dark'] as const) {
	test(`theme colour before hydration (${theme})`, async ({ page }) => {
		await page.addInitScript((mode) => localStorage.setItem('mode-watcher-mode', mode), theme);
		await page.route('**/*.js', (route) => route.abort());
		await page.goto('/sign-in');
		await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
			'content',
			theme === 'dark' ? '#121721' : '#f5f7f9'
		);
	});
}
