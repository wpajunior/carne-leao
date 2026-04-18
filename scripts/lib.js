const fs = require('node:fs/promises');
const { constants: fsConstants } = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { chromium } = require('playwright');

const LOGIN_URL = 'https://app.nidoadm.com.br/conceitosjrp/index.php/cliente/login';
const APP_URL = 'https://app.nidoadm.com.br/conceitosjrp/index.php/moduloWeb/index';
const ROOT_DIR = path.resolve(__dirname, '..');
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
const ARTIFACTS_DIR = path.join(ROOT_DIR, 'artifacts');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const AUTH_FILE = path.join(STORAGE_DIR, 'auth.json');
const LOCAL_ENV_FILE = path.join(ROOT_DIR, '.env.local');

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function ensureProjectDirs() {
  await Promise.all([ensureDir(STORAGE_DIR), ensureDir(ARTIFACTS_DIR), ensureDir(OUTPUT_DIR)]);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseEnvFile(content) {
  const values = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (!key) {
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }

    values[key] = value;
  }

  return values;
}

async function readLocalEnv() {
  if (!await fileExists(LOCAL_ENV_FILE)) {
    return {};
  }

  const content = await fs.readFile(LOCAL_ENV_FILE, 'utf8');
  return parseEnvFile(content);
}

async function getConfigValue(name) {
  if (process.env[name]) {
    return process.env[name];
  }

  const localEnv = await readLocalEnv();
  return localEnv[name] || null;
}

async function getLoginCredentials() {
  return {
    username: await getConfigValue('NIDO_USERNAME'),
    password: await getConfigValue('NIDO_PASSWORD'),
  };
}

function artifactStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function promptEnter(message) {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  try {
    await rl.question(`${message}\n`);
  } finally {
    rl.close();
  }
}

async function createBrowserContext({ useStorageState = false } = {}) {
  const browser = await chromium.launch({ headless: false, slowMo: 50 });
  const contextOptions = {};

  if (useStorageState && await fileExists(AUTH_FILE)) {
    contextOptions.storageState = AUTH_FILE;
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  return { browser, context, page };
}

function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function formatMonthYear(date) {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = String(date.getFullYear());
  return `${month}/${year}`;
}

function getPreviousMonthReference(now = new Date()) {
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return formatMonthYear(previousMonth);
}

function parseBrazilianNumber(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replace(/\./g, '').replace(',', '.').trim();
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function slugify(value) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

async function capturePageSummary(page) {
  return page.evaluate(() => {
    const currencyPattern = /R\$\s?[\d.\s]+,\d{2}/g;

    function normalize(text) {
      return text.replace(/\s+/g, ' ').trim();
    }

    function collectRows(table) {
      return Array.from(table.querySelectorAll('tr')).map((row) => (
        Array.from(row.querySelectorAll('th, td')).map((cell) => normalize(cell.textContent || ''))
      )).filter((row) => row.length > 0 && row.some(Boolean));
    }

    const tables = Array.from(document.querySelectorAll('table')).map((table, index) => {
      const rows = collectRows(table);
      return {
        index,
        caption: normalize(table.caption?.textContent || ''),
        rows,
        text: normalize(table.textContent || ''),
      };
    }).filter((table) => table.rows.length > 0 || table.text);

    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
      .map((element) => normalize(element.textContent || ''))
      .filter(Boolean);

    const labeledAmounts = Array.from(document.querySelectorAll('tr, li, p, div, span, dt, dd'))
      .map((element) => normalize(element.textContent || ''))
      .filter((text) => text && text.length <= 180 && currencyPattern.test(text))
      .slice(0, 300)
      .map((text) => ({
        text,
        currencies: text.match(currencyPattern) || [],
      }));

    const enderecoSections = [];
    let currentSection = null;
    const candidates = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6, tr, p, div, span, td, th, strong, label'));

    for (const element of candidates) {
      const text = normalize(element.textContent || '');
      if (!text || text.length > 240) {
        continue;
      }

      if (/^endere[cç]o\b/i.test(text)) {
        currentSection = {
          heading: text,
          snippets: [],
          currencies: [],
        };
        enderecoSections.push(currentSection);
        continue;
      }

      if (!currentSection) {
        continue;
      }

      const currencies = text.match(currencyPattern) || [];
      if (currencies.length === 0 && currentSection.snippets.length >= 25) {
        continue;
      }

      if (currentSection.snippets.length < 25) {
        currentSection.snippets.push(text);
      }
      currentSection.currencies.push(...currencies);
    }

    return {
      title: document.title,
      url: window.location.href,
      headings,
      tables,
      labeledAmounts,
      enderecoSections,
    };
  });
}

async function saveInspectionArtifacts(page, label) {
  const directory = path.join(ARTIFACTS_DIR, `${artifactStamp()}-${label}`);
  await ensureDir(directory);

  const html = await page.content();
  const text = cleanText(await page.locator('body').innerText());
  const summary = await capturePageSummary(page);

  await Promise.all([
    fs.writeFile(path.join(directory, 'page.html'), html, 'utf8'),
    fs.writeFile(path.join(directory, 'page.txt'), text, 'utf8'),
    fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8'),
    page.screenshot({ path: path.join(directory, 'page.png'), fullPage: true }),
  ]);

  return directory;
}

module.exports = {
  AUTH_FILE,
  APP_URL,
  LOGIN_URL,
  OUTPUT_DIR,
  ensureProjectDirs,
  createBrowserContext,
  fileExists,
  getPreviousMonthReference,
  getLoginCredentials,
  parseBrazilianNumber,
  promptEnter,
  saveInspectionArtifacts,
  slugify,
};
