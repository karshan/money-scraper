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
const CAPTCHA_IMG_SEL = '#imageText';
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

const LOG_RESPONSES = false;

type StateTag = "INITIAL" | "DONE" | "ACCOUNTS" | "CHALLENGE" | "CAPTCHA"
type State = { tag: StateTag, numAttempts: number }

type Creds = { username: string, password: string, secretQuestionAnswers: Object }

// AnyBrowserState -> ACCOUNTS | CHALLENGE | CAPTCHA
async function login(state: State, page, creds, logger : Logger): Promise<{ state: State, output: any }> {
  try {
    await page.goto(LOGIN_PAGE_URL);
  } catch(e) {
    logger.log('initial nav timed out');
  }

  await util.waitAndClick(page, USERNAME_SEL, logger);
  logger.log(USERNAME_SEL + ' resolved');
  await page.keyboard.type(creds.username);

  await util.waitAndClick(page, PASSWORD_SEL, logger);
  await page.keyboard.type(creds.password);

  if (LOG_RESPONSES) {
    page.on('response', util.responseLogger(new RegExp("//secure\.bankofamerica\.com/.*$", "i"),
      new RegExp("(\.gif|\.png|\.css|\.js|\.woff)$", "i"), logger));
  }

  const navP = page.waitForNavigation();
  await util.waitAndClick(page, SIGN_IN_BUTTON_SEL, logger);

  await navP;

  const pageAfterLogin = await Promise.race([
    page.waitForSelector(ACCOUNTS_SEL).then((r) => "ACCOUNTS"),
    page.waitForSelector(CHALLENGE_QUESTION_SEL).then((r) => "CHALLENGE"),
    page.waitForSelector(CAPTCHA_IMG_SEL).then((r) => "CAPTCHA"),
    page.waitForSelector('#RequestAuthCodeForm').then((r) => { throw "2nd Factor required" })
  ])

  return { state: { tag: pageAfterLogin, numAttempts: state.numAttempts }, output: null }
}

async function performChallenge(state: State, page, creds, logger : Logger): Promise<{ state: State, output: any }> {
  const challengeQuestion = await page.evaluate((sel) => document.querySelector(sel).innerText, CHALLENGE_QUESTION_SEL);

  const challengeKey = Object.keys(creds.secretQuestionAnswers).filter((a) => new RegExp(a, "i").test(challengeQuestion))[0];
  if (typeof challengeKey !== "string") throw `no answer for challenge ${challengeQuestion}`

  const challengeAnswer = creds.secretQuestionAnswers[challengeKey];

  if (typeof challengeAnswer !== "string") throw "couldn't find the answer";

  await util.waitAndClick(page, CHALLENGE_ANSWER_SEL, logger);
  await page.keyboard.type(challengeAnswer);
  await page.evaluate((sel) => {
    var n = document.querySelector(sel);
    if (n) { n.click(); }
  }, REMEMBER_SEL);
  await util.waitAndClick(page, CONTINUE_BUTTON_SEL, logger);

  await page.waitForSelector(ACCOUNTS_SEL);

  return { state: { tag: "ACCOUNTS", numAttempts: state.numAttempts }, output: null };
}

async function performCaptcha(state: State, page, logger : Logger): Promise<{ state: State, output: any }> {
  if (state.numAttempts >= 5) {
    throw "Failed after 5 attempts";
  }

  var captcha: string, ocrResponse: Object, ocrText: string;

  await page.waitForSelector(CAPTCHA_IMG_SEL);
  await page.waitFor((sel) => document.querySelector(sel).complete, {}, CAPTCHA_IMG_SEL);
  const natWidth = await page.evaluate((sel) => document.querySelector(sel).naturalWidth, CAPTCHA_IMG_SEL);
  logger.log({ natWidth });

  if (natWidth === 0) { // Img loaded with error
    logger.log("Captcha did not load...");
    await page.waitFor(1000);
    return { state: { tag: "INITIAL", numAttempts: state.numAttempts + 1 }, output: null };
  }

  // The captcha image is completely white sometimes, maybe some other loading goes on, wait 1 second ?
  await page.waitFor(1000);
  captcha = (await (await page.$(CAPTCHA_IMG_SEL)).screenshot()).toString('base64');
  logger.log({ captcha });
  ocrResponse = await visionClient.textDetection({ image: { content: captcha } })
  if (!ocrResponse[0] || !ocrResponse[0].fullTextAnnotation || !ocrResponse[0].fullTextAnnotation.text) {
    logger.log({ ocrResponse, error: "OCR didn't detect any fullText" });
    page.waitFor(1000);
    return { state: { tag: "INITIAL", numAttempts: state.numAttempts + 1 }, output: null };
  }

  ocrText = ocrResponse[0].fullTextAnnotation.text.trim();
  logger.log({ ocrText });

  if (ocrText.length != 6) {
    logger.log({ ocrText, ocrResponse, error: "ocrText.length != 6" });
    page.waitFor(1000);
    return { state: { tag: "INITIAL", numAttempts: state.numAttempts + 1 }, output: null };
  }

  await util.waitAndClick(page, CAPTCHA_TEXT_SEL, logger);
  await page.keyboard.type(ocrText);
  const navP = page.waitForNavigation();
  await util.waitAndClick(page, CAPTCHA_CONTINUE_SEL, logger);

  const nextPage = await Promise.race([
    page.waitForSelector(ACCOUNTS_SEL).then((r) => "ACCOUNTS"),
    page.waitForSelector(CHALLENGE_QUESTION_SEL).then((r) => "CHALLENGE"),
    navP.then((r) => page.waitForSelector(CAPTCHA_IMG_SEL)).then((r) => "CAPTCHA"),
    page.waitForSelector('#RequestAuthCodeForm').then((r) => { throw "2nd Factor required" })
  ]);

  var numAttempts = state.numAttempts;
  if (nextPage == "CAPTCHA") {
    logger.log({ ocrResponse, error: "Captch was solved incorrectly" });
    numAttempts++;
  }

  return { state: { tag: nextPage, numAttempts: numAttempts }, output: null };
}

//                   |---repeat for each account---|
//                   v                             ^
// ACCOUNTS -> AccountPage -> Download CSV -> LoginLandingPage
async function performDownloads(state, page, logger): Promise<{ state: State, output: any }> {
  const numAccounts = await page.evaluate((sel) => {
    return document.querySelectorAll(sel).length;
  }, ACCOUNTS_SEL);
  logger.log("numAccounts: " + numAccounts);

  var nameBalance = []
  for (var i = 0; i < numAccounts; i++) {
    const accountName = await page.evaluate((sel, _i) => {
      return document.querySelectorAll(sel)[_i].innerText;
    }, ACCOUNTS_SEL, i);

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
  for (var i = 0; i < numAccounts; i++) {
    await page.waitForSelector(ACCOUNTS_SEL);

    const accountType = await page.evaluate((sel, _i) => {
      var classList = document.querySelectorAll(sel)[_i].parentNode.parentNode.classList;
      if (classList.contains('AccountItemDeposit')) return "DEBIT";
      if (classList.contains('AccountItemCreditCard')) return "CREDIT";
      return null;
    }, ACCOUNTS_SEL, i);

    if (accountType == null) {
      const accountClassList = await page.evaluate((sel, _i) => {
        return document.querySelectorAll(sel)[_i].parentNode.parentNode.classList;
      }, ACCOUNTS_SEL, i);
      logger.log(`Account ${i} not CREDIT/DEBIT: ${JSON.stringify(accountClassList)}`);
      continue;
    }

    const navP = page.waitForNavigation();
    await page.evaluate((sel, _i) => {
      document.querySelectorAll(sel)[_i].click();
    }, ACCOUNTS_SEL, i);
    logger.log(`going to account ${i}`);

    await navP;

    var csvs = [];
    for (var statements_i = 1; statements_i <= 2; statements_i++) {
      logger.log(`downloading statement ${statements_i}`);
      const fileCreationP = util.waitForFileCreation(DOWNLOAD_DIR, CSV_REGEX, logger);
      if (accountType === 'DEBIT') {
        await page.waitForSelector('#depositDownLink > a');
        await page.evaluate(`
          document.querySelector('#depositDownLink > a').click(); // can also use [name=download_transactions_top]
          /* Download transactions for specific dates: {
          document.querySelector('#cust-date').click();
          document.querySelector('#start-date').value = '03/01/2014';
          document.querySelector('#end-date').value = '02/06/2018';
          } */
          document.querySelector('#select_filetype').value = "csv";
          document.querySelector('#select_txnperiod').value =
            document.querySelector('#select_txnperiod > option:nth-child(${statements_i})').value;
          document.querySelector('.submit-download').click();`);
      } else if (accountType === 'CREDIT') {
        // this selector is only presents if the statement is non-empty
        try {
          await page.waitForSelector('[name=download_transactions_top]');
        } catch(e) {
          continue;
        }
        await page.evaluate(`
          document.querySelector('[name=download_transactions_top]').click();
          // for credit no custom date, list of options is: document.querySelectorAll('#select_transaction > option')
          document.querySelector('#select_filetype').value = "&formatType=csv";
          document.querySelector('#select_transaction').value =
            document.querySelector('#select_transaction > option:nth-child(${statements_i})').value;
          document.querySelector('.submit-download').click();`);
      }
      var csvFilename = null;
      try {
        csvFilename = await fileCreationP;
      } catch(e) {
        logger.log(e);
      }
      if (csvFilename) {
        const csvContents = (await util.readFile(DOWNLOAD_DIR + csvFilename)).toString();
        await util.unlink(DOWNLOAD_DIR + csvFilename);
        csvs.push(csvContents);
      }
    }

    downloadedData.push({
      name: nameBalance[i].name,
      balance: nameBalance[i].balance,
      accountId: nameBalance[i].accountId,
      csvs: csvs,
      _type: accountType
    });

    const navigationPromise = page.waitForNavigation();
    util.waitAndClick(page, BACK_TO_ACCOUNT_SEL, logger); // no need to await here since waitForNavigation
    await navigationPromise;
  }
  return { state: { tag: "DONE", numAttempts: state.numAttempts }, output: downloadedData }
}

// TODO annotate return type
async function scrape(creds: Creds) {
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
    userDataDir: "bofa-" + creds.username
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

  var state: State = { tag: "INITIAL", numAttempts: 0 };
  var output, tmp;
  try {
    while (state.tag != "DONE") {
      logger.log({ state });
      switch(state.tag) {
        case "INITIAL":
          ({ state, output } = await login(state, page, creds, logger));
          break;
        case "ACCOUNTS":
          ({ state, output } = await performDownloads(state, page, logger));
          break;
        case "CHALLENGE":
          ({ state, output } = await performChallenge(state, page, creds, logger));
          break;
        case "CAPTCHA":
          ({ state, output } = await performCaptcha(state, page, logger));
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
