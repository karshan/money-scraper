/**
 * @fileoverview Description of this file.
 */

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

// Useful for scraping pending transactions (not currently implemented)
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
    await page.waitForSelector(sel, {visible: true});
    await page.click(sel);
  } catch(e) {
    console.log('FAILED!! waitAndClick(' + sel + '): ' + e);
    throw e;
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
  await page.goto('https://secure05c.chase.com/web/auth/dashboard');

  await page.waitForSelector('#' + LOGIN_IFRAME_NAME);
  const logonbox = await page.frames().find(f => f.name() === LOGIN_IFRAME_NAME);

  await frameWaitAndClick(logonbox, USERNAME_SEL);
  debug(USERNAME_SEL + ' resolved');
  await page.keyboard.type(CREDS.username);
  
  await frameWaitAndClick(logonbox, PASSWORD_SEL);
  await page.keyboard.type(CREDS.password);

  await frameWaitAndClick(logonbox, SIGN_IN_BUTTON_SEL);

  /*
   * Now we need to wait for the page to be ready to take us to the download
   * page if we click to early then it says no download activity available.
   * We could do this by waiting for a .../list request to complete but I'm not
   * sure which one we have to wait for. So here we click on show all
   * transactions and then wait for a particular .../list request to complete
   * after which execution continues from onResponse() -> doDownload()
   */
  function onResponse(browser, page) {
    return function (response) {
      var request = response.request();
      if (/list$/.test(request.url()) && request.postData() && /filterTranType=ALL/.test(request.postData())) {
        page.removeAllListeners('response');
        doDownload(browser, page);
      }
    }
  }

  page.on('response', onResponse(browser, page));
  await page.waitForSelector(LANDING_ALL_TRANSACTIONS_SEL);
  await waitAndClick(page, LANDING_TRANSACTIONS_DROPDOWN_SEL);
  await waitAndClick(page, LANDING_ALL_TRANSACTIONS_SEL);
}

async function doDownload(browser, page) {
  await waitAndClick(page, DOWNLOAD_ACTIVITY_SEL);

  await page.waitForSelector(ACC_SEL(0));
  const numAccounts = await page.evaluate((sel) => document.querySelector(sel).children.length, NUM_ACCOUNTS_SEL);
  debug(numAccounts + " accounts");

  for (var i = 0; i < numAccounts; i++) {
    await page.waitForSelector(ACC_SEL(i));
    await waitAndClick(page, ACCOUNT_SEL);
    await waitAndClick(page, ACC_SEL(i));

    await page.waitFor(2000); // TODO: figure out what to wait here, probably some element
    await waitAndClick(page, ACTIVITY_RANGE_SEL);
    const activityRangeClickResult = await page.evaluate((sel) => {
      var n = document.querySelector(sel).children.length;
      for (var i = 0; i < n; i++) {
        var node = document.querySelector(sel).querySelectorAll('li > a')[i];
        if (/All transactions/.test(node.innerText)) {
          setTimeout(((node_) => (() => node_.click()))(node), 1000) // TODO: also figure out what to do instead of wait here
          return node.innerText;
        }
      }
      return false;
    }, ACTIVITY_RANGE_UL_SEL);
    debug(activityRangeClickResult);

    await page.waitFor(2000); // TODO: probably actually need to wait for some request to complete here as well
    await waitAndClick(page, DOWNLOAD_BUTTON_SEL);
    debug("[" + i + "] perhaps something was downloaded, this is Yavascript ¯\\_(ツ)_/¯");
    await page.waitFor(2000);

    await waitAndClick(page, RETURN_TO_DOWNLOAD_BUTTON_SEL);
    await page.waitFor(2000);
  }

  await browser.close();
  debug("browser closed");
}

run();
