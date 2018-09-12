// @flow
const https = require('https');
const Logger = require('./logger');
const puppeteer = require('puppeteer');
const util = require('./util');
const url = require('url');
const vision = require('@google-cloud/vision');
const visionClient = new vision.ImageAnnotatorClient();

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

// captcha page
const CAPTCHA_IMG_SEL = 'img[src="/login/icaptcha"]#imageText';
const CAPTCHA_TEXT_SEL = '#captchaKey';
const CAPTCHA_CONTINUE_SEL = '#continue';
const CAPTCHA_REFRESH_SEL = 'a[name="text-img-refresh"]';
const CAPTCHA_REFRESH2_SEL = '#refresh';

// login landing page (first page after login)
const ACCOUNTS_SEL = ".AccountItem > .AccountName > a";

// From particular account page back to overview (login landing) page
const BACK_TO_ACCOUNT_SEL = "[name=onh_accounts]";

// LoginPage Url
const LOGIN_PAGE_URL = 'https://bankofamerica.com';

// _ -> LoginLandingPage
async function login(page, creds, logger) {
  await page.goto(LOGIN_PAGE_URL);

  await util.waitAndClick(page, USERNAME_SEL, logger);
  logger.log(USERNAME_SEL + ' resolved');
  await page.keyboard.type(creds.username);

  await util.waitAndClick(page, PASSWORD_SEL, logger);
  await page.keyboard.type(creds.password);

  const captchaLoadPromise = util.waitForUrlRegex(page, /login\/icaptcha/, logger);
  await util.waitAndClick(page, SIGN_IN_BUTTON_SEL, logger);

  await page.waitForNavigation();

  const pageAfterLogin = await Promise.race([
    page.waitForSelector(ACCOUNTS_SEL).then((r) => "ACCOUNTS"),
    page.waitForSelector(CHALLENGE_QUESTION_SEL).then((r) => "CHALLENGE"),
    page.waitForSelector(CAPTCHA_IMG_SEL).then((r) => "CAPTCHA")
  ])

  if (pageAfterLogin === "ACCOUNTS") return;

  if (pageAfterLogin === "CHALLENGE") {
    const challengeQuestion = await page.evaluate((sel) => document.querySelector(sel).innerText, CHALLENGE_QUESTION_SEL);

    const challengeKey = creds.secretQuestionAnswers.keys.filter((a) => new RegExp(a, "i").test(challengeQuestion))[0];
    if (typeof challengeKey !== "string") throw `no answer for challenge ${challengeQuestion}`

    const challengeAnswer = creds.secretQuestionAnswers[challengeKey];

    if (typeof challengeAnswer !== "string") throw "couldn't find the answer";

    await util.waitAndClick(page, CHALLENGE_ANSWER_SEL, logger);
    await page.keyboard.type(challengeAnswer);
    await util.waitAndClick(page, REMEMBER_SEL, logger);
    await util.waitAndClick(page, CONTINUE_BUTTON_SEL, logger);
  } else if (pageAfterLogin === "CAPTCHA") {
    await captchaLoadPromise;

    var captchaElement, captchaPngB64;
    var ocrResult, ocrResultText;
    var done = false;
    var attemptsLeft = 5;
    while (attemptsLeft-- > 0 && done == false) {
      captchaElement = await page.$(CAPTCHA_IMG_SEL);
      logger.log({ captchaWidth: await (await captchaElement.getProperty('width')).jsonValue() });
      await page.waitFor(10000);
      logger.log({ captchaWidth: await (await captchaElement.getProperty('width')).jsonValue() });

      captchaPngB64 = (await captchaElement.screenshot()).toString('base64');
      logger.log({ captcha: captchaPngB64 });
      ocrResult = await visionClient.textDetection({ image: { content: captchaPngB64 } })
      if (!ocrResult[0] || !ocrResult[0].fullTextAnnotation || !ocrResult[0].fullTextAnnotation.text) {
          logger.log({ ocrResult: ocrResult });
          throw "bad ocrResult";
      }
      ocrResultText = ocrResult[0].fullTextAnnotation.text.trim();
      logger.log({ ocrResultText: ocrResultText });
      if (!/Use this text/.test(ocrResultText) && ocrResultText.length == 6) {
        done = true;
        break;
      }

      await util.waitAndClick(page, CAPTCHA_REFRESH_SEL, logger);
      await util.waitAndClick(page, CAPTCHA_REFRESH2_SEL, logger);
    }

    if (done == false) {
      throw 'captcha never loaded';
    }

    await util.waitAndClick(page, CAPTCHA_TEXT_SEL, logger);
    await page.keyboard.type(ocrResultText);
    await util.waitAndClick(page, CAPTCHA_CONTINUE_SEL, logger);
    await page.waitForNavigation();

    throw "capsha unimplemented"
  } else {
    // impossible ?
    throw "pageAfterLogin != ACCOUNTS,CHALLENGE or CAPTCHA"
  }
}

//                   |---repeat for each account---|
//                   v                             ^
// LoginLandingPage -> AccountPage -> Download CSV -> LoginLandingPage
async function performDownloads(page, logger) {
  await page.waitForSelector(ACCOUNTS_SEL);

  const numAccounts = await page.evaluate((sel) => {
    return document.querySelectorAll(sel).length;
  }, ACCOUNTS_SEL);
  logger.log("numAccounts: " + numAccounts);

  var nameBalance = []
  // FIXME numAccounts-1 is hack specific to me. We should check the accounttype
  // before scraping
  for (var i = 0; i < numAccounts - 1; i++) {
    const accountName = await page.evaluate((sel, _i) => {
      return document.querySelectorAll(sel)[_i].innerText;
    }, ACCOUNTS_SEL, i);

    // FIXME: This balance includes pending transactions that are not returned
    // by this scraper. For debit this can be fixed by not returning a balance
    // since the correct balance is included in the CSV. for credit ¯\_(ツ)_/¯
    const accountBalance = await page.evaluate((sel, _i) => {
      return document.querySelectorAll(sel)[_i].parentNode.parentNode.querySelector('.AccountBalance').innerText
    }, ACCOUNTS_SEL, i);

    const accountHref = await page.evaluate((sel, _i) => {
      return document.querySelectorAll(sel)[_i].href;
    }, ACCOUNTS_SEL, i);

    nameBalance.push({
      name: accountName,
      balance: accountBalance,
      // $FlowFixMe
      accountId: url.parse(accountHref, true).query.adx
    });
  }

  var downloadedData = []
  // FIXME numAccounts-1 is hack specific to me. We should check the accounttype
  // before scraping
  for (var i = 0; i < numAccounts - 1; i++) {
    await page.waitForSelector(ACCOUNTS_SEL);

    await page.evaluate((sel, _i) => {
      document.querySelectorAll(sel)[_i].click();
    }, ACCOUNTS_SEL, i);
    logger.log(`going to account ${i}`);

    await page.waitForNavigation();

    /*
     * another way to figure out if debit or credit account:
     * > document.querySelectorAll(ACCOUNTS_SEL)[0].parentNode.parentNode.classList
     * > DOMTokenList(2) ["AccountItem", "AccountItemDeposit", value: "AccountItem AccountItemDeposit"]
     */
    const accountType = await Promise.race([
      page.waitForSelector('#depositDownLink > a').then((r) => 'DEBIT'),
      page.waitForSelector('#makePaymentWidget').then((r) => 'CREDIT')
    ])

    if (accountType === 'DEBIT') {
      await page.evaluate(`
        document.querySelector('#depositDownLink > a').click(); // can also use [name=download_transactions_top]
        /* Download transactions for specific dates: {
        document.querySelector('#cust-date').click();
        document.querySelector('#start-date').value = '03/01/2014';
        document.querySelector('#end-date').value = '02/06/2018';
        } */
        document.querySelector('#select_filetype').value = "csv";
        document.querySelector('.submit-download').click();`);
    } else if (accountType === 'CREDIT') {
      await page.evaluate(`
        document.querySelector('[name=download_transactions_top]').click();
        // for credit no custom date, list of options is: document.querySelectorAll('#select_transaction > option')
        document.querySelector('#select_filetype').value = "&formatType=csv";
        document.querySelector('.submit-download').click();`);
    }
    const csvFilename = await util.waitForFileCreation(DOWNLOAD_DIR, CSV_REGEX, logger);
    const csvContents = (await util.readFile(DOWNLOAD_DIR + csvFilename)).toString();
    await util.unlink(DOWNLOAD_DIR + csvFilename);

    downloadedData.push({
      name: nameBalance[i].name,
      balance: nameBalance[i].balance,
      accountId: nameBalance[i].accountId,
      csv: csvContents,
      _type: accountType
    });

    const navigationPromise = page.waitForNavigation();
    util.waitAndClick(page, BACK_TO_ACCOUNT_SEL, logger); // no need to await here since waitForNavigation
    await navigationPromise;
  }
  return downloadedData;
}

async function scrape(creds: { username: string, password: string, secretQuestionAnswers: Object }) {
  var logger = new Logger(false);

  if (typeof creds.username !== "string" ||
      typeof creds.password !== "string" ||
      typeof creds.secretQuestionAnswers !== "object") {
    return { ok: false, error: 'bad creds' };
  }

  /*
   * TODO: is a fixed userDataDir safe for concurrent use ?
   * removing the userDataDir option will make it so a temporary profile
   * dir is used instead which is deleted on browser.close(). This means
   * cookies and browser cache will not be saved.
   */
  const browser = await puppeteer.launch({
    headless: true,
    userDataDir: "chrome-profile"
  });
  const page = await browser.newPage();

  await page.setUserAgent(USER_AGENT);

  // FIXME a fixed download_dir is a problem for concurrent requests
  // because headless chrome doesn't download to filename (1) if
  // filename exists for some reason.
  await page._client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR
  });

  await page.setViewport({ width: 1920, height: 1080 });

  try {
    await login(page, creds, logger);
    const downloadedData = await performDownloads(page, logger);

    return {
      ok: true,
      downloadedData: downloadedData,
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
