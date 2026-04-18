const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');
const chalk = require('chalk');
const { default: inquirer } = require('inquirer');
const { ensureProjectDirs } = require('./lib');

const RENDIMENTOS_URL = 'https://www3.cav.receita.fazenda.gov.br/carneleao/rendimentos';
const RENDIMENTO_FORM_URL = 'https://www3.cav.receita.fazenda.gov.br/carneleao/rendimentos/rendimento';
const ROOT_DIR = path.resolve(__dirname, '..');
const STORAGE_DIR = path.join(ROOT_DIR, 'storage');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const CARNE_LEAO_AUTH_FILE = path.join(STORAGE_DIR, 'carne-leao-auth.json');
const CHROME_EXECUTABLE = '/opt/google/chrome/chrome';

const DRY_RUN = process.argv.includes('--dry-run');

// ─── TUI helpers ─────────────────────────────────────────────────────────────

const WIDTH = 66;

function line(char = '─') {
  return chalk.gray(char.repeat(WIDTH));
}

function header(text) {
  const pad = Math.max(0, WIDTH - text.length - 2);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  console.log(chalk.bgBlue.white.bold(' '.repeat(left) + ` ${text} ` + ' '.repeat(right)));
}

function row(label, value, valueColor = chalk.white) {
  const labelStr = chalk.gray(label.padEnd(18));
  console.log(`  ${labelStr} ${valueColor(value)}`);
}

function brl(value) {
  return `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`;
}

function printPaymentCard(data, index, total, deductionValue, netValue, historico, receiptDate) {
  console.log('');
  console.log(line('─'));
  console.log(chalk.bold.cyan(`  [${index}/${total}] ${data.address}`));
  console.log(line('─'));
  row('Imóvel',      data.propertyType);
  row('Locatário',   data.tenantName);
  row('CPF',         data.tenantCpf, chalk.yellow);
  row('Referência',  data.reference);
  row('Data receb.', receiptDate, chalk.yellow);
  console.log(chalk.gray('  ' + '·'.repeat(WIDTH - 2)));
  row('Natureza',    'Aluguel');
  row('Histórico',   historico.length > 46 ? historico.slice(0, 43) + '…' : historico, chalk.gray);
  console.log(chalk.gray('  ' + '·'.repeat(WIDTH - 2)));
  row('Valor Bruto',  brl(data.totalValue), chalk.white);
  row('Dedução',      brl(deductionValue),  chalk.red);
  row('Valor Líquido', brl(netValue),       chalk.green.bold);
  console.log(line('─'));
}

// ─── Business logic ───────────────────────────────────────────────────────────

async function loadOutputFiles() {
  const files = (await fs.readdir(OUTPUT_DIR)).filter((f) => f.endsWith('.json'));
  return Promise.all(
    files.map(async (file) => {
      const raw = await fs.readFile(path.join(OUTPUT_DIR, file), 'utf8');
      return { file, data: JSON.parse(raw) };
    })
  );
}

function extractDeductions(data) {
  return data.lineItems
    .filter((item) =>
      item.description?.includes('Taxa ADM') ||
      item.description?.includes('IPTU') ||
      /seguro/i.test(item.description ?? '')
    )
    .reduce((sum, item) => sum + (item.debitValue ?? 0), 0);
}

function extractRentLineItem(data) {
  return data.lineItems.find((item) => item.creditValue && item.creditValue > 0) ?? null;
}

function resolveReceiptDate(data) {
  if (data.transfer?.paymentDate) return data.transfer.paymentDate;
  return extractRentLineItem(data)?.dueDate ?? null;
}

function buildHistorico(data) {
  // reference is "MM/YYYY" → convert to "MM/YY"
  const [mm, yyyy] = (data.reference ?? '').split('/');
  const mmyy = mm && yyyy ? `${mm}/${yyyy.slice(2)}` : data.reference ?? '';
  const text = `Aluguel - ${data.address} - ${mmyy}`;
  return text.length <= 255 ? text : text.slice(0, 255);
}

async function fillCurrencyField(page, selector, value) {
  const rounded = (Math.round(value * 100) / 100).toFixed(2);
  const field = page.locator(selector);
  await field.click({ clickCount: 3 });
  await field.pressSequentially(rounded.replace('.', ','), { delay: 40 });
}

async function selectNatureza(page, label) {
  const toggle = page.locator('ngx-select[name="natureza"] .ngx-select__toggle').first();
  await toggle.click();
  const option = page
    .locator('ngx-select[name="natureza"] .ngx-select__item')
    .filter({ hasText: label })
    .first();
  await option.waitFor({ state: 'visible', timeout: 5000 });
  await option.click();
}

async function navigateToRendimentoForm(page) {
  await page.goto(RENDIMENTOS_URL, { waitUntil: 'domcontentloaded' });
  // Ensure the Angular router is active by clicking the menu link
  const menuLink = page.locator('a[href="/carneleao/rendimentos"]').first();
  await menuLink.waitFor({ state: 'visible', timeout: 10000 });
  await menuLink.click();
  await page.locator('button[title="incluir rendimento"]').waitFor({ state: 'visible', timeout: 15000 });
  await page.locator('button[title="incluir rendimento"]').click();
  // Wait for the Angular form to render
  await page.locator('ngx-select[name="natureza"] .ngx-select__toggle').first().waitFor({ state: 'visible', timeout: 15000 });
}

async function fillForm(page, data, receiptDate, historico, deductionValue) {
  await navigateToRendimentoForm(page);

  await selectNatureza(page, 'Aluguel');

  const dateField = page.locator('#dataLancamento');
  await dateField.click({ clickCount: 3 });
  await dateField.fill(receiptDate);
  await page.keyboard.press('Escape');

  // nb-radio wraps a visually-hidden input — click the component itself
  await page.locator('nb-radio[value="PF"]').click();

  const cpfField = page.locator('#cpfTitularPagamento');
  await cpfField.click({ clickCount: 3 });
  await cpfField.pressSequentially(data.tenantCpf.replace(/\D/g, ''), { delay: 40 });
  await page.waitForTimeout(1500);

  const historicoField = page.locator('#historico');
  await historicoField.click({ clickCount: 3 });
  await historicoField.fill(historico);

  await fillCurrencyField(page, '#valorCheio', data.totalValue);
  await fillCurrencyField(page, '#valorDeducao', deductionValue);
}

async function registerRendimento(page, data, index, total) {
  const receiptDate = resolveReceiptDate(data);
  const historico = buildHistorico(data);
  const deductionValue = extractDeductions(data);
  const netValue = Math.round((data.totalValue - deductionValue) * 100) / 100;

  if (!receiptDate || !data.totalValue) {
    console.log(chalk.yellow(`  ⚠  Skipping — missing date or value`));
    return 'skipped';
  }

  printPaymentCard(data, index, total, deductionValue, netValue, historico, receiptDate);

  if (DRY_RUN) {
    console.log(chalk.gray('  [dry-run] No form will be submitted.\n'));
    return 'dry-run';
  }

  await fillForm(page, data, receiptDate, historico, deductionValue);

  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: chalk.yellow('Form is ready in the browser. Submit it there, then confirm here to continue.'),
    default: true,
  }]);

  if (!confirm) {
    console.log(chalk.gray('  Skipped.\n'));
    return 'skipped';
  }

  console.log(chalk.green('  ✅  Done.\n'));
  return 'registered';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await ensureProjectDirs();

  const entries = await loadOutputFiles();
  if (entries.length === 0) {
    console.log(chalk.yellow('No payment files found in output/.'));
    return;
  }

  console.log('');
  header(`CARNÊ-LEÃO — REGISTRAR RENDIMENTOS${DRY_RUN ? '  [DRY RUN]' : ''}`);
  console.log('');

  for (const { data } of entries) {
    const deductionValue = extractDeductions(data);
    const netValue = Math.round((data.totalValue - deductionValue) * 100) / 100;
    console.log(
      `  ${chalk.cyan('•')} ${chalk.white(data.tenantName.padEnd(30))}` +
      `  ${chalk.gray(data.reference)}` +
      `  ${chalk.green.bold(brl(netValue))}`
    );
  }

  console.log('');

  const { proceed } = await inquirer.prompt([{
    type: 'confirm',
    name: 'proceed',
    message: `Open browser and start registering ${entries.length} payment(s)?`,
    default: true,
  }]);

  if (!proceed) {
    console.log(chalk.gray('Aborted.'));
    return;
  }

  const browser = await chromium.launch({
    executablePath: CHROME_EXECUTABLE,
    headless: false,
    slowMo: 80,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });

  const context = await browser.newContext({
    storageState: CARNE_LEAO_AUTH_FILE,
    locale: 'pt-BR',
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  const counts = { registered: 0, skipped: 0 };

  try {
    await page.goto(RENDIMENTOS_URL, { waitUntil: 'domcontentloaded' });
    if (page.url().includes('login') || page.url().includes('autenticacao')) {
      console.log(chalk.red('\n❌  Session expired. Run: npm run save-session-carne-leao'));
      return;
    }

    for (const [i, { data }] of entries.entries()) {
      const result = await registerRendimento(page, data, i + 1, entries.length);
      if (result === 'registered') counts.registered++;
      else if (result === 'skipped') counts.skipped++;
      else if (result === 'quit') break;
    }
  } finally {
    await browser.close();
  }

  console.log('');
  console.log(line('═'));
  console.log(
    `  ${chalk.bold('Summary')}  ` +
    chalk.green(`✅ ${counts.registered} registered`) + '  ' +
    chalk.gray(`⏭  ${counts.skipped} skipped`)
  );
  console.log(line('═'));
  console.log('');
}

main().catch((error) => {
  console.error(chalk.red(error.message));
  process.exitCode = 1;
});
