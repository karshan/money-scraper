const CREDS = require('./creds');
const util = require('./util');
const puppeteer = require('puppeteer');

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
const ACC_SEL = (x) => "#container-primary-" + x + "-account-selector"

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

// LoginPage Url TODO: fix this to something that always goes to login.
// This will open the dashboard if already logged in.
const LOGIN_PAGE_URL = 'https://secure05c.chase.com/web/auth/dashboard';

// _ -> LoginLandingPage
async function login(page) {
  await page.goto(LOGIN_PAGE_URL);

  await page.waitForSelector('#' + LOGIN_IFRAME_NAME);
  const logonbox = await page.frames().find(f => f.name() === LOGIN_IFRAME_NAME);

  await util.frameWaitAndClick(logonbox, USERNAME_SEL);
  util.debug(USERNAME_SEL + ' resolved');
  await page.keyboard.type(CREDS.username);

  await util.frameWaitAndClick(logonbox, PASSWORD_SEL);
  await page.keyboard.type(CREDS.password);

  await util.frameWaitAndClick(logonbox, SIGN_IN_BUTTON_SEL);
}

// LoginLandingPage -> DownloadPage
async function gotoDownloadPage(page) {
  await util.waitForUrlRegex(page, ACTIVITY_CARD_LIST_REGEX);
  await util.waitAndClick(page, DOWNLOAD_ACTIVITY_SEL);
}

// DownloadPage -> DownloadPage (downloads CSV's for all accounts)
async function performDownloads(page) {
  const accountsPromise = await util.waitForUrlRegex(page, ACTIVITY_DOWNLOAD_OPTIONS_LIST_REGEX);
  await util.waitForUrlRegex(page, STATEMENTPERIOD_OPTIONS_CARD_LIST_REGEX);
  await accountsPromise;

  await page.waitForSelector(ACC_SEL(0));
  const numAccounts = await page.evaluate((sel) => document.querySelector(sel).children.length, NUM_ACCOUNTS_SEL);
  util.debug(numAccounts + " accounts");

  for (var i = 0; i < numAccounts; i++) {
    await page.waitForSelector(ACC_SEL(i));
    await util.waitAndClick(page, ACCOUNT_SEL);
    await util.waitAndClick(page, ACC_SEL(i));

    // this one is tricky, chase will prefetch for ACC_SEL(0) always,
    // but for other acc's this request will be made after waitAndClick ACC_SEL(i)
    if (i != 0) {
      await util.waitForUrlRegex(page, STATEMENTPERIOD_OPTIONS_CARD_LIST_REGEX);
    }

    await util.waitAndClick(page, ACTIVITY_RANGE_SEL);
    const activityRangeClickResult = await page.evaluate((sel) => {
      var n = document.querySelector(sel).children.length;
      for (var i = 0; i < n; i++) {
        var node = document.querySelector(sel).querySelectorAll('li > a')[i];
        if (/All transactions/.test(node.innerText)) {
          setTimeout(((node_) => (() => node_.click()))(node), 1000) // TODO: don't know what actually needs to be waited here for
          return node.innerText;
        }
      }
      return false;
    }, ACTIVITY_RANGE_UL_SEL);
    util.debug(activityRangeClickResult);

    await page.waitFor(1100); // TODO: don't know what actually needs to be waited for, doesn't seem to be a request
    await util.waitAndClick(page, DOWNLOAD_BUTTON_SEL);
    util.debug("[" + i + "] perhaps something was downloaded, this is Yavascript ¯\\_(ツ)_/¯");

    await util.waitAndClick(page, RETURN_TO_DOWNLOAD_BUTTON_SEL);
    await util.waitForUrlRegex(page, STATEMENTPERIOD_OPTIONS_CARD_LIST_REGEX);
  }
}

async function run() {
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: "chrome-profile"
  });
  const page = await browser.newPage();

  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3312.0 Safari/537.36");

  await page._client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: './'
  });

  await page.setViewport({ width: 800, height: 600 });

  await login(page);
  await gotoDownloadPage(page);
  await performDownloads(page);

  await browser.close();
  util.debug("browser closed");
}

run();
