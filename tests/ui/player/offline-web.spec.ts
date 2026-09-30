import { expect, test } from '../fixtures/test';

// The browser build with its real host (scripts/navidrome-preview.ts) when the server stops
// answering. The browser keeps nothing, so it says so and offers Retry.
test('the browser version says the server is out of reach, keeps nothing, and comes back on Retry', async ({ page, app, fake }) => {
  await app.signIn();
  fake.unreachable = true;
  await app.section('Artists').click();
  await expect(app.heading).toHaveText('Your server is out of reach');
  await expect(app.main.getByText(/The browser version keeps nothing on this device, so music returns when the server does\./)).toBeVisible();
  await expect(app.main.getByRole('button', { name: 'Open kept songs' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Squiggly home' }).click();
  await expect(app.heading).toHaveText('Your server is out of reach');
  await expect(page.getByRole('button', { name: /Keep on this device/ })).toHaveCount(0);
  fake.unreachable = false;
  await app.section('Artists').click();
  await app.main.getByRole('button', { name: 'Retry' }).click();
  await expect(app.heading).toHaveText('Artists');
});
