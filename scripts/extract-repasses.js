const fs = require('node:fs/promises');
const path = require('node:path');
const {
  AUTH_FILE,
  OUTPUT_DIR,
  createBrowserContext,
  ensureProjectDirs,
  fileExists,
  getPreviousMonthReference,
  parseBrazilianNumber,
  slugify,
} = require('./lib');

const REPASSES_URL = 'https://app.nidoadm.com.br/conceitosjrp/index.php/moduloWeb/repasses';

function parseBrazilianDate(value) {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) {
    return null;
  }

  const [, day, month, year] = match;
  return new Date(`${year}-${month}-${day}T00:00:00`);
}

function extractBetween(text, startMarker, endMarker) {
  const startIndex = text.indexOf(startMarker);
  if (startIndex === -1) {
    return null;
  }

  const start = startIndex + startMarker.length;
  if (!endMarker) {
    return text.slice(start).trim();
  }

  const endIndex = text.indexOf(endMarker, start);
  if (endIndex === -1) {
    return null;
  }

  return text.slice(start, endIndex).trim();
}

function parseContractHeader(headerText) {
  return {
    contractId: headerText.match(/^Contrato\s+(\d+)/)?.[1] || null,
    validity: extractBetween(headerText, 'Vigência:', ' - Imóvel:'),
    propertyId: extractBetween(headerText, 'Imóvel:', ' / Endereço:'),
    address: extractBetween(headerText, 'Endereço:', ' - Tipo Imóvel:'),
    propertyType: extractBetween(headerText, 'Tipo Imóvel:', null),
  };
}

function parseTenantRow(text) {
  return {
    tenantName: extractBetween(text, 'INQ.:', ' - CPF:'),
    tenantCpf: extractBetween(text, 'CPF:', null),
  };
}

function parseRepasseRow(text) {
  return {
    repasseId: text.match(/Repasse:\s*(\d+)/)?.[1] || null,
    reference: text.match(/Competência:\s*(\d{2}\/\d{4})/)?.[1] || null,
  };
}

function parseCurrencyString(value) {
  return value ? value.trim() : null;
}

function pickLastCurrency(row) {
  for (let index = row.length - 1; index >= 1; index -= 1) {
    const value = parseCurrencyString(row[index]);
    if (value) {
      return value;
    }
  }

  return null;
}

function parseDetailRows(rows) {
  const paymentSources = [];
  const overall = {
    totalDebits: null,
    totalCredits: null,
    totalTaxaAdm: null,
    totalPaid: null,
    totalPendingParticipant: null,
  };
  let current = null;

  const pushCurrent = () => {
    if (!current) {
      return;
    }

    paymentSources.push({
      contractId: current.contractId,
      propertyId: current.propertyId,
      address: current.address,
      propertyType: current.propertyType,
      validity: current.validity,
      repasseId: current.repasseId,
      reference: current.reference,
      tenantName: current.tenantName,
      tenantCpf: current.tenantCpf,
      taxaAdm: current.taxaAdm,
      repasseRule: current.repasseRule,
      total: current.creditTotal,
      totalValue: parseBrazilianNumber(current.creditTotal),
      discounts: current.debitTotal,
      discountsValue: parseBrazilianNumber(current.debitTotal),
      remainingAmount: current.netTotal,
      remainingAmountValue: parseBrazilianNumber(current.netTotal),
      lineItems: current.lineItems,
    });
  };

  for (const row of rows) {
    const firstCell = row[0] || '';

    if (/^Contrato\s+\d+\b/.test(firstCell)) {
      pushCurrent();
      const contract = parseContractHeader(firstCell);
      current = {
        ...contract,
        taxaAdm: row[1] || null,
        repasseRule: row[2] || null,
        repasseId: null,
        reference: null,
        tenantName: null,
        tenantCpf: null,
        debitTotal: null,
        creditTotal: null,
        netTotal: null,
        lineItems: [],
      };
      continue;
    }

    if (/^Total de débitos e créditos$/i.test(firstCell)) {
      pushCurrent();
      current = null;
      overall.totalDebits = parseCurrencyString(row[1] || null);
      overall.totalDebitsValue = parseBrazilianNumber(row[1] || null);
      overall.totalCredits = parseCurrencyString(row[2] || null);
      overall.totalCreditsValue = parseBrazilianNumber(row[2] || null);
      continue;
    }

    if (/^Total Taxa Adm$/i.test(firstCell)) {
      pushCurrent();
      current = null;
      overall.totalTaxaAdm = pickLastCurrency(row);
      overall.totalTaxaAdmValue = parseBrazilianNumber(overall.totalTaxaAdm);
      continue;
    }

    if (/^Total Pago$/i.test(firstCell)) {
      overall.totalPaid = pickLastCurrency(row);
      overall.totalPaidValue = parseBrazilianNumber(overall.totalPaid);
      continue;
    }

    if (/^Total Pendente Participante$/i.test(firstCell)) {
      overall.totalPendingParticipant = pickLastCurrency(row);
      overall.totalPendingParticipantValue = parseBrazilianNumber(overall.totalPendingParticipant);
      continue;
    }

    if (!current) {
      continue;
    }

    if (/^INQ\.:/.test(firstCell)) {
      Object.assign(current, parseTenantRow(firstCell));
      continue;
    }

    if (/^Repasse:/.test(firstCell)) {
      Object.assign(current, parseRepasseRow(firstCell));
      continue;
    }

    if (/^Subtotais de débitos e créditos$/i.test(firstCell)) {
      current.debitTotal = parseCurrencyString(row[1] || null);
      current.creditTotal = parseCurrencyString(row[2] || null);
      continue;
    }

    if (/^Total$/i.test(firstCell)) {
      current.netTotal = parseCurrencyString(row[row.length - 1] || null);
      continue;
    }

    if (/^\d{2}\/\d{2}\/\d{4}$/.test(firstCell) && !/PAGAMENTO EFETUADO/i.test(row[1] || '')) {
      current.lineItems.push({
        dueDate: row[0],
        description: row[1] || null,
        grossAmount: parseCurrencyString(row[2] || null),
        grossAmountValue: parseBrazilianNumber(row[2] || null),
        participation: row[3] || null,
        debit: parseCurrencyString(row[4] || null),
        debitValue: parseBrazilianNumber(row[4] || null),
        credit: parseCurrencyString(row[5] || null),
        creditValue: parseBrazilianNumber(row[5] || null),
      });
    }
  }

  pushCurrent();

  return { paymentSources, overall };
}

async function filterGridToReference(page, reference) {
  await page.goto(REPASSES_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle');
  await page.locator('#tabExtrato').waitFor({ state: 'visible', timeout: 30000 });

  await page.evaluate(async (targetReference) => {
    const $ = window.jQuery;
    const grid = $.fn?.yiiGridView;
    if (!$ || !grid) {
      throw new Error('Yii grid view helpers were not loaded on the repasses page.');
    }

    const filters = {
      'receberFilter[id]': '',
      'receberFilter[contrato]': '',
      'receberFilter[endereco]': '',
      'receberFilter[referencia]': targetReference,
      'receberFilter[valor_previsto]': '',
      'receberFilter[data_baixa]': '',
      'receberFilter[valor_baixa]': '',
      'receberFilter[situacao]': 'Pago',
    };

    const referenceInput = document.querySelector('#receberFilter_referencia');
    if (referenceInput) {
      referenceInput.value = targetReference;
    }

    const statusSelect = document.querySelector('#receberFilter_situacao');
    if (statusSelect) {
      statusSelect.value = 'Pago';
    }

    await new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        reject(new Error(`Timed out updating the repasses grid for ${targetReference}.`));
      }, 30000);

      grid.update('tabExtrato', {
        data: filters,
        complete: () => {
          window.clearTimeout(timeoutId);
          resolve();
        },
        error: (xhr) => {
          window.clearTimeout(timeoutId);
          reject(new Error(xhr?.responseText || 'Failed to update the repasses grid.'));
        },
      });
    });
  }, reference);

  await page.waitForLoadState('networkidle');
}

async function readGridRows(page) {
  const rows = await page.locator('#tabExtrato tbody tr').evaluateAll((tableRows) => (
    tableRows.map((row, index) => {
      const cells = Array.from(row.querySelectorAll('td')).map((cell) => (
        (cell.textContent || '').replace(/\s+/g, ' ').trim()
      ));
      const link = row.querySelector('a[title="Gerar este extrato"]');

      return {
        index,
        cells,
        actionHref: link?.getAttribute('href') || '',
      };
    }).filter((row) => row.cells.length >= 9)
  ));

  return rows.map((row) => ({
    index: row.index,
    repasse: row.cells[1],
    contrato: row.cells[2],
    enderecoResumo: row.cells[3],
    reference: row.cells[4],
    previsto: row.cells[5],
    previstoValue: parseBrazilianNumber(row.cells[5]),
    paymentDate: row.cells[6],
    paid: row.cells[7],
    paidValue: parseBrazilianNumber(row.cells[7]),
    status: row.cells[8],
    actionHref: row.actionHref,
  }));
}

function selectTransfersForReference(rows, reference) {
  const candidates = rows
    .filter((row) => row.reference === reference && row.status === 'Pago')
    .sort((left, right) => {
      const leftDate = parseBrazilianDate(left.paymentDate)?.getTime() || 0;
      const rightDate = parseBrazilianDate(right.paymentDate)?.getTime() || 0;
      if (leftDate !== rightDate) {
        return rightDate - leftDate;
      }

      return Number(right.repasse) - Number(left.repasse);
    });

  if (candidates.length === 0) {
    throw new Error(`No paid transfer was found for reference ${reference}.`);
  }

  return candidates;
}

async function openTransferDetail(page, context, rowIndex) {
  const popupPromise = context.waitForEvent('page', { timeout: 30000 });
  await page.locator('#tabExtrato tbody a[title="Gerar este extrato"]').nth(rowIndex).click();
  const popup = await popupPromise;

  await popup.waitForLoadState('domcontentloaded');
  await popup.waitForLoadState('networkidle');
  return popup;
}

async function readDetailTableRows(popup) {
  const table = popup.locator('table.table').first();
  await table.waitFor({ state: 'visible', timeout: 30000 });

  return table.locator('tr').evaluateAll((rows) => (
    rows.map((row) => Array.from(row.querySelectorAll('th, td'))
      .map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim()))
      .filter((cells) => cells.some(Boolean))
  ));
}

async function writeOutputs(reference, transfers, paymentSources) {
  const referencePrefix = reference.replace('/', '-');
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const generatedAt = new Date().toISOString();
  const individualPaths = [];
  for (const source of paymentSources) {
    const fileName = [
      referencePrefix,
      source.listRepasseId || source.repasseId || 'repasse',
      String(source.contractId || 'sem-contrato').padStart(2, '0'),
      slugify(source.address || source.repasseId || 'fonte'),
    ].join('-') + '.json';
    const filePath = path.join(OUTPUT_DIR, fileName);

    await fs.writeFile(filePath, JSON.stringify({
      generatedAt,
      reference,
      transfer: transfers.find((transfer) => transfer.repasse === source.listRepasseId) || null,
      totals: source.transferTotals,
      ...source,
    }, null, 2), 'utf8');

    individualPaths.push(filePath);
  }

  return { individualPaths };
}

async function main() {
  await ensureProjectDirs();

  if (!await fileExists(AUTH_FILE)) {
    throw new Error(`Saved session not found at ${AUTH_FILE}. Run "npm run save-session" first.`);
  }

  const reference = process.env.REFERENCE || getPreviousMonthReference();
  const { browser, context, page } = await createBrowserContext({ useStorageState: true });

  try {
    await filterGridToReference(page, reference);
    const gridRows = await readGridRows(page);
    const selectedTransfers = selectTransfersForReference(gridRows, reference);
    const allPaymentSources = [];
    for (const transfer of selectedTransfers) {
      const popup = await openTransferDetail(page, context, transfer.index);
      const detailRows = await readDetailTableRows(popup);
      const parsedDetail = parseDetailRows(detailRows);
      await popup.close();

      if (parsedDetail.paymentSources.length === 0) {
        throw new Error(`The transfer detail for repasse ${transfer.repasse} did not contain any payment sources.`);
      }

      allPaymentSources.push(...parsedDetail.paymentSources.map((source) => ({
        ...source,
        listRepasseId: transfer.repasse,
        listContrato: transfer.contrato,
        listAddressSummary: transfer.enderecoResumo,
        listPaymentDate: transfer.paymentDate,
        transferTotals: parsedDetail.overall,
      })));
    }

    const outputs = await writeOutputs(reference, selectedTransfers, allPaymentSources);

    console.log(JSON.stringify({
      reference,
      transferCount: selectedTransfers.length,
      paymentSources: allPaymentSources.length,
      individualPaths: outputs.individualPaths,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
