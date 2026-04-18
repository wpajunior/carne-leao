const {
  AUTH_FILE,
  LOGIN_URL,
  createBrowserContext,
  ensureProjectDirs,
  getLoginCredentials,
  promptEnter,
} = require('./lib');

async function autofillCredentials(page) {
  const credentials = await getLoginCredentials();

  if (!credentials.username || !credentials.password) {
    return false;
  }

  await page.locator('#username').fill(credentials.username);
  await page.locator('#password').fill(credentials.password);
  return true;
}

async function main() {
  await ensureProjectDirs();

  const { browser, context, page } = await createBrowserContext();

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    const credentialsFilled = await autofillCredentials(page);
    await promptEnter(
      credentialsFilled
        ? 'Credentials were filled automatically. Complete the captcha and submit the login in the browser. When you are already inside the system, press Enter here to save the session.'
        : 'Complete the login and captcha in the opened browser. When you are already inside the system, press Enter here to save the session.'
    );
    await context.storageState({ path: AUTH_FILE });
    console.log(`Session saved to ${AUTH_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
