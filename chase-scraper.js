const Logger = require('./logger');
const puppeteer = require('puppeteer');
const util = require('./util');

const DOWNLOAD_DIR = './downloads/';
const CSV_REGEX = new RegExp("\.csv$", "i");

// login page
const LOGIN_IFRAME_NAME = "logonbox"
const SIGN_IN_BUTTON_SEL = "#signin-button"
const USERNAME_SEL = "#userId-input-field"
const PASSWORD_SEL = "#password-input-field"

// landing page (first page after login)
const DOWNLOAD_ACTIVITY_SEL = "#downloadActivityIcon"
const LANDING_TRANSACTIONS_DROPDOWN_SEL = "#header-transactionTypeOptions"
const LANDING_ALL_TRANSACTIONS_SEL = "#container-4-transactionTypeOptions"

// Info useful for scraping pending transactions (not currently implemented):
// To switch accounts on the login landing page see the direct children of
// .tile-image nodes.
// e.g. document.querySelectorAll(".tile-image")[0].children[0]
// and document.querySelectorAll(".tile-image")[1].children[0]

// Following snippet shows how to map chase account-numbers to masked cc numbers:
// document.querySelectorAll(".account-tile")[0].id
// "tile-<chase acc number>"
// document.querySelectorAll(".account-tile")[0].querySelector('.main-tile > .top-container > .left-section > .title > .mask-number')
// <span class="mask-number TILENUMACTIVE">(...<masked-cc-number>)</span>
// document.querySelectorAll(".account-tile").length
// <number of accounts>

// download page
const ACCOUNT_SEL = "#header-account-selector"
const NUM_ACCOUNTS_SEL = "#ul-list-container-account-selector"
const ACC_SEL = (x) => "#container-" + x + "-account-selector"

const ACTIVITY_RANGE_SEL = "#header-styledSelect1"
const ACTIVITY_RANGE_UL_SEL = "#ul-list-container-styledSelect1"

const DOWNLOAD_BUTTON_SEL = "#download"

// post download page
RETURN_TO_DOWNLOAD_BUTTON_SEL = "#downloadOtherActivity"

// URL regex's used with waitForUrlRegex()

// https://secure05c.chase.com/svc/rr/accounts/secure/v1/account/activity/card/list
const ACTIVITY_CARD_LIST_REGEX = new RegExp("/account/activity/card/list$");
// https://secure05c.chase.com/svc/rr/accounts/secure/v1/account/activity/download/options/list (account list for dropdown?)
const ACTIVITY_DOWNLOAD_OPTIONS_LIST_REGEX = new RegExp("/account/activity/download/options/list$");
// https://secure05c.chase.com/svc/rr/accounts/secure/v1/account/statementperiod/options/card/list (activity ranges for account)
const STATEMENTPERIOD_OPTIONS_CARD_LIST_REGEX = new RegExp("/account/statementperiod/options/card/list$");

// LoginPage Url
// Navigating here will open the dashboard if already logged in.
const LOGIN_PAGE_URL = 'https://secure05c.chase.com/web/auth/dashboard';

// _ -> LoginLandingPage
async function login(page, creds, logger) {
  await page.goto(LOGIN_PAGE_URL);

  // Detect if we are already logged in. Could also use page.title() probably
  const loggedIn = await Promise.race([
    page.waitForSelector('#' + LOGIN_IFRAME_NAME).then((r) => false),
    page.waitForSelector(DOWNLOAD_ACTIVITY_SEL).then((r) => true)
  ]);

  if (loggedIn) {
    return;
  }

  const logonbox = await page.frames().find(f => f.name() === LOGIN_IFRAME_NAME);

  await util.frameWaitAndClick(logonbox, USERNAME_SEL);
  logger.log(USERNAME_SEL + ' resolved');
  await page.keyboard.type(creds.username);

  await util.frameWaitAndClick(logonbox, PASSWORD_SEL);
  await page.keyboard.type(creds.password);

  await util.frameWaitAndClick(logonbox, SIGN_IN_BUTTON_SEL);
}

// LoginLandingPage -> DownloadPage
async function gotoDownloadPage(page, logger) {
  await util.waitForUrlRegex(page, ACTIVITY_CARD_LIST_REGEX, logger);

  try {
    await util.waitAndClick(page, DOWNLOAD_ACTIVITY_SEL, logger);
  } catch(e) {
    throw {
      msg: `waitAndClick ${DOWNLOAD_ACTIVITY_SEL} failed. Probably because login required 2 factor`,
      exception: e.toString()
    };
  }
}

// DownloadPage -> DownloadPage (downloads CSV's for all accounts)
// returns [{accountId, filename, jsonTransactions}]
async function performDownloads(page, logger) {
  const accountsPromise = await util.waitForUrlRegex(page, ACTIVITY_DOWNLOAD_OPTIONS_LIST_REGEX, logger);
  await util.waitForUrlRegex(page, STATEMENTPERIOD_OPTIONS_CARD_LIST_REGEX, logger);
  await accountsPromise;

  await page.waitForSelector(ACC_SEL(0));
  const numAccounts = await page.evaluate((sel) => document.querySelector(sel).children.length, NUM_ACCOUNTS_SEL);
  logger.log(numAccounts + " accounts");

  var downloadedFiles = [];
  for (var i = 0; i < numAccounts; i++) {
    await page.waitForSelector(ACC_SEL(i));
    await util.waitAndClick(page, ACCOUNT_SEL, logger);
    await util.waitAndClick(page, ACC_SEL(i), logger);
    const accountId = await page.evaluate((sel) => document.querySelector(sel).rel, ACC_SEL(i));

    // this one is tricky, chase will prefetch for ACC_SEL(0) always,
    // but for other acc's this request will be made after waitAndClick ACC_SEL(i)
    if (i != 0) {
      await util.waitForUrlRegex(page, STATEMENTPERIOD_OPTIONS_CARD_LIST_REGEX, logger);
    }

    await util.waitAndClick(page, ACTIVITY_RANGE_SEL, logger);
    const activityRangeClickResult = await page.evaluate((sel) => {
      var n = document.querySelector(sel).children.length;
      for (var i = 0; i < n; i++) {
        var node = document.querySelector(sel).querySelectorAll('li > a')[i];
        if (/All transactions/.test(node.innerText)) {
          setTimeout(((node_) => (() => node_.click()))(node), 1000) // TODO: don't know what actually needs to be waited for
          return node.innerText;
        }
      }
      return false;
    }, ACTIVITY_RANGE_UL_SEL);
    logger.log(activityRangeClickResult);

    await page.waitFor(1100); // TODO: don't know what actually needs to be waited for, doesn't seem to be a request
    await util.waitAndClick(page, DOWNLOAD_BUTTON_SEL, logger);

    downloadedFiles.push({
      accountId: accountId,
      filename: await util.waitForFileCreation(DOWNLOAD_DIR, CSV_REGEX, logger)
    });

    await util.waitAndClick(page, RETURN_TO_DOWNLOAD_BUTTON_SEL, logger);
    await util.waitForUrlRegex(page, STATEMENTPERIOD_OPTIONS_CARD_LIST_REGEX, logger);
  }

  for (var i = 0; i < downloadedFiles.length; i++) {
    const a = downloadedFiles[i];
    const resPromise = util.waitForUrlRegex(page, ACTIVITY_CARD_LIST_REGEX, logger);
    page.evaluate((accountId) => {
      fetch('https://secure05c.chase.com/svc/rr/accounts/secure/v1/account/activity/card/list', {
        'credentials': 'include',
        'method': 'POST',
        'headers': new Headers({
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'x-jpmc-csrf-token': 'NONE'
        }),
        'body': `accountId=${accountId}&filterTranType=ALL&statementPeriodId=ALL`
      })
    }, a.accountId)
    const res = await resPromise;
    logger.log(`RES = ${res}`)
    downloadedFiles[i].jsonTransactions = res.responseBody;
    logger.log({accId: downloadedFiles[i].accountId, json: downloadedFiles[i].jsonTransactions});
  }
  return downloadedFiles;
}

async function scrape(creds) {
  var logger = new Logger(false);

  if (typeof creds.username !== "string" || typeof creds.password !== "string") {
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
    userDataDir: "chrome-profile"
  });
  const page = await browser.newPage();

  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3312.0 Safari/537.36");

  await page._client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR
  });

  await page.setViewport({ width: 800, height: 600 });

  try {
    await login(page, creds, logger);
    await gotoDownloadPage(page, logger);

    const downloadedFilenames = await performDownloads(page, logger);
    logger.log({ msg: 'downloaded', obj: downloadedFilenames });

    const downloadedData = await Promise.all(downloadedFilenames.map(async(a) => {
      return {
        accountId: a.accountId,
        filename: a.filename,
        contents: (await util.readFile(DOWNLOAD_DIR + a.filename)).toString(),
        jsonTransactions: a.jsonTransactions
      }
    }));

    await Promise.all(downloadedFilenames.map(async(a) =>
      await util.unlink(DOWNLOAD_DIR + a.filename))
    );

    return {
      ok: true,
      downloadedData: downloadedData,
      log: logger.getLog()
    };
  } catch(e) {
    var screenshot;
    try {
      screenshot = (await page.screenshot()).toString('base64');
    } catch(e) {
    } finally {
      logger.log({
        msg: `SCRAPER FAILURE`,
        exception: e.toString(),
        screenshot: screenshot
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
