const CREDS = require('./creds');
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

function debug(x) {
  console.log("DEBUG: " + x);
}

// unused util function:
async function responseLogger(response) {
  var request = response.request();
  var responseBody = await response.text();
  if (!/\/raw\/$/.test(request.url()) && !/dynaTraceMonitor/.test(request.url())) {
      console.log("======== LOG ========");
      console.log("url: " + request.url());
      console.log("method: " + request.method());
      if (request.postData()) {
        console.log("request-length: " + request.postData().length);
        console.log("postData: " + request.postData().substring(0, 1000));
      }
      console.log("response-length: " + responseBody.length);
      console.log("response: " + responseBody.substring(0, 1000));
      console.log("----------8<---------");
  }
}

async function frameWaitAndClick(frame, sel) {
  try {
    await frame.waitForSelector(sel, {visible: true});
    const toClick = await frame.$(sel);
    await toClick.click();
  } catch(e) {
    console.log('FAILED!! frameWaitAndClick(' + sel + '): ' + e);
    throw e;
  }
}

async function waitAndClick(page, sel) {
  try {
    debug('waitAndClick START ' + sel);
    await page.waitForSelector(sel, {visible: true});
    await page.click(sel);
    debug('waitAndClick END ' + sel);
  } catch(e) {
    console.log('FAILED!! waitAndClick(' + sel + '): ' + e);
    throw e;
  }
}

function promiseTimeout(ms, promise){
  // Create a promise that rejects in <ms> milliseconds
  let id;
  let timeout = new Promise((resolve, reject) => {
    id = setTimeout(() => {
      reject('Timed out in '+ ms + 'ms.');
    }, ms)
  })

  // Returns a race between our timeout and the passed in promise
  return Promise.race([
    promise,
    timeout
  ]).then((result) => {
    clearTimeout(id);
    return result;
  })
}

function waitForResponse(page, predicate) {
  return promiseTimeout(30000, new Promise(function (resolve, reject) {
    var responseHandler = function(response) {
      if (predicate(response.request(), response)) {
        page.removeListener('response', responseHandler);
        debug('waitForResponse END ' + response.request().url());
        resolve();
      }
    }
    page.on('response', responseHandler);
  }));
}

function waitForUrlRegex(page, urlRegex) {
  debug("waitForUrlRegex START " + urlRegex);
  return waitForResponse(page, (req, resp) => urlRegex.test(req.url()));
}

// https://secure05c.chase.com/svc/rr/accounts/secure/v1/account/activity/card/list
const ACTIVITY_CARD_LIST_REGEX = new RegExp("/account/activity/card/list$");
// https://secure05c.chase.com/svc/rr/accounts/secure/v1/account/activity/download/options/list (account list for dropdown?)
const ACTIVITY_DOWNLOAD_OPTIONS_LIST_REGEX = new RegExp("/account/activity/download/options/list$");
// https://secure05c.chase.com/svc/rr/accounts/secure/v1/account/statementperiod/options/card/list (activity ranges for account)
const STATEMENTPERIOD_OPTIONS_CARD_LIST_REGEX = new RegExp("/account/statementperiod/options/card/list$");

// _ -> LoginLandingPage
async function login(page) {
  await page.goto('https://secure05c.chase.com/web/auth/dashboard');

  await page.waitForSelector('#' + LOGIN_IFRAME_NAME);
  const logonbox = await page.frames().find(f => f.name() === LOGIN_IFRAME_NAME);

  await frameWaitAndClick(logonbox, USERNAME_SEL);
  debug(USERNAME_SEL + ' resolved');
  await page.keyboard.type(CREDS.username);
  
  await frameWaitAndClick(logonbox, PASSWORD_SEL);
  await page.keyboard.type(CREDS.password);

  await frameWaitAndClick(logonbox, SIGN_IN_BUTTON_SEL);
}

// LoginLandingPage -> DownloadPage
async function gotoDownloadPage(page) {
  await waitForUrlRegex(page, ACTIVITY_CARD_LIST_REGEX);
  await waitAndClick(page, DOWNLOAD_ACTIVITY_SEL);
}

// DownloadPage -> DownloadPage (downloads CSV's for all accounts)
async function performDownloads(page) {
  const accountsPromise = await waitForUrlRegex(page, ACTIVITY_DOWNLOAD_OPTIONS_LIST_REGEX);
  await waitForUrlRegex(page, STATEMENTPERIOD_OPTIONS_CARD_LIST_REGEX);
  await accountsPromise;

  await page.waitForSelector(ACC_SEL(0));
  const numAccounts = await page.evaluate((sel) => document.querySelector(sel).children.length, NUM_ACCOUNTS_SEL);
  debug(numAccounts + " accounts");

  for (var i = 0; i < numAccounts; i++) {
    await page.waitForSelector(ACC_SEL(i));
    await waitAndClick(page, ACCOUNT_SEL);
    await waitAndClick(page, ACC_SEL(i));

    // this one is tricky, chase will prefetch for ACC_SEL(0) always,
    // but for other acc's this request will be made after waitAndClick ACC_SEL(i)
    if (i != 0) {
      await waitForUrlRegex(page, STATEMENTPERIOD_OPTIONS_CARD_LIST_REGEX);
    }

    await waitAndClick(page, ACTIVITY_RANGE_SEL);
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
    debug(activityRangeClickResult);

    await page.waitFor(1100); // TODO: don't know what actually needs to be waited for, doesn't seem to be a request
    await waitAndClick(page, DOWNLOAD_BUTTON_SEL);
    debug("[" + i + "] perhaps something was downloaded, this is Yavascript ¯\\_(ツ)_/¯");

    await waitAndClick(page, RETURN_TO_DOWNLOAD_BUTTON_SEL);
    await waitForUrlRegex(page, STATEMENTPERIOD_OPTIONS_CARD_LIST_REGEX);
  }
}

async function run() {
  const browser = await puppeteer.launch({
    headless: false,
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
  debug("browser closed");
}

run();
