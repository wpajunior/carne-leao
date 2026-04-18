const { chromium } = require('playwright');
const path = require('node:path');
const {
  ensureProjectDirs,
  promptEnter,
} = require('./lib');

const CARNE_LEAO_LOGIN_URL =
  'https://servicos.receitafederal.gov.br/login?redirectUrl=https://cav.receita.fazenda.gov.br/eCAC/publico/login.aspx?sistema=10028';

const ROOT_DIR = path.resolve(__dirname, '..');
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
const CARNE_LEAO_AUTH_FILE = path.join(STORAGE_DIR, 'carne-leao-auth.json');
const CHROME_EXECUTABLE = '/opt/google/chrome/chrome';

async function main() {
  await ensureProjectDirs();

  const browser = await chromium.launch({
    executablePath: CHROME_EXECUTABLE,
    headless: false,
    slowMo: 50,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-infobars',
    ],
  });

  const context = await browser.newContext({
    locale: 'pt-BR',
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  try {
    await page.goto(CARNE_LEAO_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await promptEnter(
      'Complete the login in the opened browser. When you are already inside the system, press Enter here to save the session.'
    );
    await context.storageState({ path: CARNE_LEAO_AUTH_FILE });
    console.log(`Session saved to ${CARNE_LEAO_AUTH_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
