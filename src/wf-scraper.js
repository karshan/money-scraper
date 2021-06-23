// @flow
const https = require('https');
const Logger = require('./logger');
const puppeteer = require('puppeteer');
const pluginStealth = require("puppeteer-extra-plugin-stealth")
const util = require('./util');
const url = require('url');

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3312.0 Safari/537.36";
const DOWNLOAD_DIR = './downloads/';
const CSV_REGEX = new RegExp("\.csv$", "i");

// LoginPage Url
const LOGIN_PAGE_URL = 'https://wellsfargo.com';

// login page
const SIGN_IN_BUTTON_SEL = "#btnSignon"
const USERNAME_SEL = "#userid";
const PASSWORD_SEL = "#password";
const USERNAME2_SEL = "#j_username";
const PASSWORD2_SEL = "#j_password";
const SIGN_IN_BUTTON2_SEL = "[data-testid=signon-button]"

const ACCOUNTS_SEL = "[data-testid=account-list]"

type StateTag = "INITIAL" | "LOGIN2" | "DONE" | "ACCOUNTS"
type State = { tag: StateTag, numAttempts: number }

type Creds = { username: string, password: string, secretQuestionAnswers: Object }

async function login(state: State, page, creds, logger : Logger): Promise<{ state: State, output: any }> {
  try {
    await page.goto(LOGIN_PAGE_URL);
  } catch(e) {
    logger.log('initial nav timed out');
  }

  await page.waitFor(10000);

  await util.waitAndClick(page, USERNAME_SEL, logger);
  logger.log(USERNAME_SEL + ' resolved');
  await page.keyboard.type(creds.username);

  await util.waitAndClick(page, PASSWORD_SEL, logger);
  await page.keyboard.type(creds.password);

  await Promise.all([
    page.waitForNavigation(),
    util.waitAndClick(page, SIGN_IN_BUTTON_SEL, logger)
  ]);

  const pageAfterLogin = await Promise.race([
    page.waitForSelector(ACCOUNTS_SEL).then((r) => "ACCOUNTS"),
    page.waitForSelector(USERNAME2_SEL).then((r) => "LOGIN2"),
  ])

  return { state: { tag: pageAfterLogin, numAttempts: state.numAttempts }, output: null }
}

async function login2(state: State, page, creds, logger : Logger): Promise<{ state: State, output: any }> {
  await util.waitAndClick(page, USERNAME2_SEL, logger);
  await page.keyboard.type(creds.username);

  await util.waitAndClick(page, PASSWORD2_SEL, logger);
  await page.keyboard.type(creds.password);

  await Promise.all([
    page.waitForNavigation(),
    util.waitAndClick(page, SIGN_IN_BUTTON2_SEL, logger)
  ]);

  const pageAfterLogin = await Promise.race([
    page.waitForSelector(ACCOUNTS_SEL).then((r) => "ACCOUNTS"),
    page.waitForSelector(USERNAME2_SEL).then((r) => "LOGIN2"),
  ])

  var outAttempts = state.numAttempts;
  if (pageAfterLogin == "LOGIN2") outAttempts++;

  return { state: { tag: pageAfterLogin, numAttempts: outAttempts }, output: null }
}

async function performDownloads(state, page, logger): Promise<{ state: State, output: any }> {
  var numAccounts = await page.evaluate((sel) => {
    return document.querySelector(sel).children[0].children.length;
  }, ACCOUNTS_SEL);
  numAccounts -= 1; // FIXME identify rewards accounts and don't count them
  logger.log("numAccounts: " + numAccounts);

  var nameBalance = []
  for (var i = 0; i < numAccounts; i++) {
    const accountName = await page.evaluate((sel, _i) => {
      return document.querySelector(sel).children[0].children[_i].getAttribute('data-testid');
    }, ACCOUNTS_SEL, i);

    var accountBalance = 0;
    try {
      accountBalance = await page.evaluate((sel, _i) => {
        return document.querySelector(sel).children[0].children[_i].children[0].children[0].children[1].children[0].innerText
      }, ACCOUNTS_SEL, i);
    } catch(e) {
    }

    var accountId = null;
    try {
      accountId = await page.evaluate((sel, _i) => {
        return document.querySelector(sel).children[0].children[_i].querySelector('div > div').children[0].children[0].children[0].getAttribute('aria-labelledby').split(' ')[0]
      }, ACCOUNTS_SEL, i);
    } catch(e) {}

    nameBalance.push({
      name: accountName,
      balance: accountBalance,
      accountId: accountId
    });
  }

  // goto download accountactivity page
  const navP = page.waitForNavigation();
  await page.evaluate((sel, _i) => {
    document.querySelector(sel).children[0].children[_i].querySelector('div > div').children[0].children[0].children[0].click();
  }, ACCOUNTS_SEL, 0);

  await navP;

  await page.waitForSelector('.transaction-links');
  const downloadStr = await page.evaluate(`document.querySelector('.transaction-links > ul > li').innerText`);
  if (downloadStr !== "Download Account Activity") {
    logger.log("download activity button has non matching innerText: " + downloadStr);
  }

  logger.log('downloadStr = ' + downloadStr);
  await page.waitFor(10000);

  const navP2 = page.waitForNavigation();
  await util.waitAndClick(page, '.transaction-links > ul > li > a', logger);
  await navP2;

  var downloadedData = []
  for (var i = 0; i < numAccounts; i++) {
    await page.waitForSelector(`#selectedAccountId-option-${i}`);
    await page.evaluate(`document.querySelector('#selectedAccountId-option-${i}').click()`);
    await util.waitAndClick(page, '[data-for=commaDelimited]', logger);

    const fileCreationP = util.waitForFileCreation(DOWNLOAD_DIR, CSV_REGEX, logger);
    await page.evaluate(`document.querySelector('#btn-continue').click()`);
    var csvFilename = null;
    var csvContents = null;
    try {
      csvFilename = await fileCreationP;
    } catch(e) {
      logger.log(e);
    }
    if (csvFilename) {
      csvContents = (await util.readFile(DOWNLOAD_DIR + csvFilename)).toString();
      await util.unlink(DOWNLOAD_DIR + csvFilename);
    }

    downloadedData.push({
      name: nameBalance[i].name,
      balance: nameBalance[i].balance,
      accountId: nameBalance[i].accountId,
      csv: csvContents
    });
  }

  return { state: { tag: "DONE", numAttempts: state.numAttempts }, output: downloadedData }
}

// TODO annotate return type
async function scrape(creds: Creds) {
  var logger = new Logger(true);

  if (typeof creds.username !== "string" ||
      typeof creds.password !== "string") {
    return { ok: false, error: 'bad creds' };
  }

  /*
   * TODO: is a fixed userDataDir safe for concurrent use ?
   * removing the userDataDir option will make it so a temporary profile
   * dir is used instead which is deleted on browser.close(). This means
   * cookies and browser cache will not be saved.
   */
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: "wf-" + creds.username
  });
  const page = await browser.newPage();

  //  await page.setUserAgent(USER_AGENT);

  // FIXME a fixed download_dir is a problem for concurrent requests
  // because headless chrome doesn't download to filename (1) if
  // filename exists for some reason.
  await page._client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR
  });

  await page.setViewport({ width: 1920, height: 1080 });

  var state: State = { tag: "INITIAL", numAttempts: 0 };
  var output;

  try {
    while (state.tag != "DONE") {
      if (state.numAttempts > 5) { logger.log("TOO MANY ATTEMPTS"); break; }
      logger.log({ state });
      switch(state.tag) {
        case "INITIAL":
          ({ state, output } = await login(state, page, creds, logger));
          break;
        case "LOGIN2":
          ({ state, output } = await login2(state, page, creds, logger));
          break;
        case "ACCOUNTS":
          ({ state, output } = await performDownloads(state, page, logger));
          break;
      }
    }
    return {
      ok: true,
      downloadedData: output,
      log: logger.getLog()
    };
  } catch(e) {
    var screenshot, domscreenshot;
    try {
      screenshot = (await page.screenshot()).toString('base64');
      domscreenshot = await page.evaluate(`document.querySelector("body").innerHTML`);
    } catch(e) {
    } finally {
      logger.log({
        msg: `SCRAPER FAILURE`,
        exception: (e.toString() === "[object Object]") ? JSON.stringify(e) : e.toString(),
        screenshot: screenshot,
        domscreenshot: domscreenshot
      });

      return { ok: false, error: 'see log', log: logger.getLog() };
    }
  } finally {
    await browser.close();
  }
}

module.exports = {
  scrape: scrape
}
