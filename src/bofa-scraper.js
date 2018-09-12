// @flow
const https = require('https');
const Logger = require('./logger');
const puppeteer = require('puppeteer');
const util = require('./util');
const url = require('url');
const vision = require('@google-cloud/vision');
const visionClient = new vision.ImageAnnotatorClient();
const speech = require('@google-cloud/speech');
const speechClient = new speech.SpeechClient();

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
  await page.goto(LOGIN_PAGE_URL);

  await util.waitAndClick(page, USERNAME_SEL, logger);
  logger.log(USERNAME_SEL + ' resolved');
  await page.keyboard.type(creds.username);

  await util.waitAndClick(page, PASSWORD_SEL, logger);
  await page.keyboard.type(creds.password);

  if (LOG_RESPONSES) {
    page.on('response', util.responseLogger(new RegExp("//secure\.bankofamerica\.com/.*$", "i"),
      new RegExp("(\.gif|\.png|\.css|\.js|\.woff)$", "i"), logger));
  }

  await util.waitAndClick(page, SIGN_IN_BUTTON_SEL, logger);

  await page.waitForNavigation();

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
  await util.waitAndClick(page, REMEMBER_SEL, logger);
  await util.waitAndClick(page, CONTINUE_BUTTON_SEL, logger);

  await page.waitForSelector(ACCOUNTS_SEL);

  return { state: { tag: "ACCOUNTS", numAttempts: state.numAttempts }, output: null };
}

async function performCaptcha(state: State, page, logger : Logger): Promise<{ state: State, output: any }> {
  async function audioCaptchaUNUSED() {
    const audioCaptchaP = page.waitForResponse(response => new RegExp("login/audioCaptcha", "i").test(response.url()))
    await util.waitAndClick(page, 'a[name="audio"]', logger);
    const audioCaptcha = (await (await audioCaptchaP).buffer()).toString('base64');
    const speechResp = await speechClient.recognize({
      audio: {
        content: audioCaptcha
      },
      config: {
        encoding: 'LINEAR16',
        languageCode: 'en-US',
      }
    });
    logger.log(speechResp);
    throw "audio captcha unimplemented";
  }

  var captcha;
  var ocrResponse, ocrText;
  var done = false;
  var attemptsLeft = 5;

  if (state.numAttempts >= 5) {
    throw "Failed after 5 attempts";
  }

  while (attemptsLeft-- > 0 && done == false) {
    logger.log('waitForSelector CAPTCHA_IMG_SEL BEGIN');
    await page.waitForSelector(CAPTCHA_IMG_SEL);
    logger.log('waitFor .complete BEGIN');
    await page.waitFor((sel) => document.querySelector(sel).complete, {}, CAPTCHA_IMG_SEL);
    const natWidth = await page.evaluate((sel) => document.querySelector(sel).naturalWidth, CAPTCHA_IMG_SEL);
    logger.log({ natWidth });

    if (natWidth === 0) { // Img loaded with error
      logger.log("Captcha did not load...");
      page.waitFor(2000);
      return { state: { tag: "INITIAL", numAttempts: state.numAttempts + 1 }, output: null };
    }

    captcha = (await (await page.$(CAPTCHA_IMG_SEL)).screenshot()).toString('base64');
    logger.log({ captcha });
    ocrResponse = await visionClient.textDetection({ image: { content: captcha } })
    if (!ocrResponse[0] || !ocrResponse[0].fullTextAnnotation || !ocrResponse[0].fullTextAnnotation.text) {
      logger.log({ ocrResponse, error: "bad ocrResponse" });
      await page.waitFor(2000);
      await util.waitAndClick(page, CAPTCHA_REFRESH_SEL, logger);
      await page.waitFor(2000);
      await util.waitAndClick(page, CAPTCHA_REFRESH2_SEL, logger);
      await page.waitFor(10000);
      continue;
    }

    ocrText = ocrResponse[0].fullTextAnnotation.text.trim();
    logger.log({ ocrText });
    if (ocrText.length == 6) {
      done = true;
      break;
    }
  }

  if (done == false) {
    throw 'captcha never loaded';
  }

  await util.waitAndClick(page, CAPTCHA_TEXT_SEL, logger);
  await page.keyboard.type(ocrText);
  await util.waitAndClick(page, CAPTCHA_CONTINUE_SEL, logger);
  await page.waitForNavigation();

  const nextPage = await Promise.race([
    page.waitForSelector(ACCOUNTS_SEL).then((r) => "ACCOUNTS"),
    page.waitForSelector(CHALLENGE_QUESTION_SEL).then((r) => "CHALLENGE"),
    page.waitForSelector(CAPTCHA_IMG_SEL).then((r) => "CAPTCHA"),
    page.waitForSelector('#RequestAuthCodeForm').then((r) => { throw "2nd Factor required" })
  ]);

  return { state: { tag: nextPage, numAttempts: state.numAttempts + (nextPage == "CAPTCHA" ? 1 : 0) }, output: null };
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
