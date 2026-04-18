# Carnê-Leão Automation

## Steps

### 1. Log in to Nido ADM
```bash
npm run save-session
```
A browser window opens — log in manually, then press Enter in the terminal.

### 2. Extract repasses
```bash
npm run extract-repasses
```
Reads the transfers from Nido ADM and writes JSON files to `output/`. Also generates files for any properties listed in `manual-payments.json`.

### 3. Log in to Carnê-Leão
```bash
npm run save-session-carne-leao
```
A browser window opens — complete the login (including any captcha) manually, then press Enter in the terminal.

### 4. Register rendimentos
```bash
npm run register-rendimentos
```
Opens the Receita Federal site with the saved session, fills in each payment form, and waits for you to submit and confirm before moving to the next one.

> Use `npm run register-rendimentos:dry` to preview all payments without opening a browser.
