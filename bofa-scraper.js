const https = require('https');
const Logger = require('./logger');
const puppeteer = require('puppeteer');
const util = require('./util');

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/65.0.3312.0 Safari/537.36";
const DOWNLOAD_DIR = './downloads/';
const CSV_REGEX = new RegExp("\.csv$", "i");

// login page
const SIGN_IN_BUTTON_SEL = "#signIn"
const USERNAME_SEL = "#onlineId1";
const PASSWORD_SEL = "#passcode1";

// challenge page
const CHALLENGE_QUESTION_SEL = "[for=tlpvt-challenge-answer]"; // "#VerifyCompForm > div.answer-section > label"
const CHALLENGE_ANSWER_SEL = "#tlpvt-challenge-answer";
const REMEMBER_SEL = "#yes-recognize"; // yes remember this computer
const CONTINUE_BUTTON_SEL = "#verify-cq-submit";

// login landing page (first page after login)
const ACCOUNT_ITEM_SEL = ".AccountItem";
/*
document.querySelectorAll('.AccountItem > .AccountName > a')[0].innerText
"BofA Core Checking - 6150"
document.querySelectorAll('.AccountItem > .AccountBalance > .balanceValue')[0].innerText
"$7,957.74"
*/


// landing page (first page after login)
const DOWNLOAD_ACTIVITY_SEL = "#downloadActivityIcon"
const LANDING_TRANSACTIONS_DROPDOWN_SEL = "#header-transactionTypeOptions"
const LANDING_ALL_TRANSACTIONS_SEL = "#container-4-transactionTypeOptions"

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
const LOGIN_PAGE_URL = 'https://bankofamerica.com';

// _ -> LoginLandingPage
async function login(page, creds, logger) {
  await page.goto(LOGIN_PAGE_URL);

  await util.waitAndClick(page, USERNAME_SEL, logger);
  logger.log(USERNAME_SEL + ' resolved');
  await page.keyboard.type(creds.username);

  await util.waitAndClick(page, PASSWORD_SEL, logger);
  await page.keyboard.type(creds.password);

  await util.waitAndClick(page, SIGN_IN_BUTTON_SEL, logger);

  await page.waitForNavigation();

  // TODO do challenge only if asked (race with .AccountItem)
  const challenged = await Promise.race([
    page.waitForSelector(ACCOUNT_ITEM_SEL).then((r) => false),
    page.waitForSelector(CHALLENGE_QUESTION_SEL).then((r) => true)
  ])
  
  if (!challenged) return;

  const challengeQuestion = await page.evaluate((sel) => document.querySelector(sel).innerText, CHALLENGE_QUESTION_SEL);

  const challengeAnswer = creds.secretQuestionAnswers.filter((a) => new RegExp(a[0], "i").test(challengeQuestion))[0][1];

  if (typeof challengeAnswer !== "string") throw "couldn't find the answer";

  await util.waitAndClick(page, CHALLENGE_ANSWER_SEL, logger);
  await page.keyboard.type(challengeAnswer);
  await util.waitAndClick(page, REMEMBER_SEL, logger);
  await util.waitAndClick(page, CONTINUE_BUTTON_SEL, logger);
}

async function performDownloads(page, logger) {
  await page.waitForSelector(ACCOUNT_ITEM_SEL);

  const numAccounts = await page.evaluate(() => {
    document.querySelectorAll('.AccountItem > .AccountName > a').length;
  });
  logger("numAccounts: " + numAccounts);

  for (var i = 0; i < 

  await page.waitForNavigation();
  await page.evaluate(() => {
    document.querySelector('#depositDownLink > a').click()
    document.querySelector('#cust-date').click()
    document.querySelector('#start-date').value = '01/01/2017';
    document.querySelector('#end-date').value = '01/01/2018';
    document.querySelector('#select_filetype').value = "csv"
    document.querySelector('.submit-download').click()
  });
}

async function scrape(creds) {
  var logger = new Logger(true);

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

  await page.setUserAgent(USER_AGENT);

  await page._client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR
  });

  await page.setViewport({ width: 1920, height: 1080 });

  //try {
    await login(page, creds, logger);
    const downloadedFilenames = await performDownloads(page, logger);
/*

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
        exception: (typeof e === "object") ? JSON.stringify(e) : e.toString(),
        screenshot: screenshot
      });

      return { ok: false, error: 'see log', log: logger.getLog() };
    }
  } finally {
    await browser.close();
  }
*/
}

module.exports = {
  scrape: scrape
}
