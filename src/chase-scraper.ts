const https = require('https');
const Logger = require('./logger');
const puppeteer = require('puppeteer-extra');

const util = require('./util');

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.106 Safari/537.36"
const DOWNLOAD_DIR = './downloads/';

// login page
const LOGIN_IFRAME_NAME = "logonbox"
const SIGN_IN_BUTTON_SEL = "#signin-button"
const USERNAME_SEL = "#userId-text-input-field"
const PASSWORD_SEL = "#password-text-input-field"

// URL regex used with waitForUrlRegex()
// https://secure05c.chase.com/svc/rr/accounts/secure/v1/account/activity/card/list
const ACTIVITY_CARD_LIST_REGEX = new RegExp("/account/activity/card/list$");
const SIGN_OUT_BUTTON_SEL = "#convo-deck-sign-out"

// LoginPage Url
// Navigating here will open the dashboard if already logged in.
const LOGIN_PAGE_URL = 'https://secure05a.chase.com/web/auth/dashboard';

async function login(page, creds, logger) {
  try {
    await page.goto(LOGIN_PAGE_URL);
  } catch (e) {
    logger.log("initial nav timed out, bah whatever: " + e.toString());
  }

  // Detect if we are already logged in.
  const isLoggedIn = await Promise.race([
    page.waitForSelector('#' + LOGIN_IFRAME_NAME).then((r) => false),
    page.waitForSelector(SIGN_OUT_BUTTON_SEL).then((r) => true)
  ]);

  if (isLoggedIn) {
    logger.log("already logged in");
    page.waitFor(5000);
    try {
      await Promise.race([
        page.waitForSelector('.account-tile').then((r) => true),
        page.waitForSelector('.account-category').then((r) => true),
        page.waitForSelector('.single-account-summary').then((r) => true)
      ]);
    } catch (e) {
      logger.log("wait for account tile timed out");
      return false;
    }
    return true;
  }

  const logonbox = await page.frames().find(f => f.name() === LOGIN_IFRAME_NAME);
  if (logonbox === undefined || logonbox === null) {
    throw {
      msg: 'logonbox not found'
    }
  }

  await page.waitFor(5000);

  await util.frameWaitAndClick(logonbox, USERNAME_SEL);
  logger.log(USERNAME_SEL + ' resolved');
  await page.keyboard.type(creds.username);

  await util.frameWaitAndClick(logonbox, PASSWORD_SEL);
  await page.keyboard.type(creds.password);

  //  navP = page.waitForNavigation({waitUntil: 'networkidle0'});
  await util.frameWaitAndClick(logonbox, SIGN_IN_BUTTON_SEL);
  /*  logger.log("begin nav wait");
    try {
      await navP;
    } catch(e) {
      logger.log("nav wait timed out");
      return false;
    }
    logger.log("end nav wait");
    */

  try {
    await page.waitForSelector(SIGN_OUT_BUTTON_SEL); // util.waitForUrlRegex(page, ACTIVITY_CARD_LIST_REGEX, logger);
  } catch (e) {
    logger.log("wait for sign out button timed out");
    return false;
  }

  try {
    await Promise.race([
      page.waitForSelector('.account-tile').then((r) => true),
      page.waitForSelector('.single-account-summary').then((r) => true)
    ]);
  } catch (e) {
    logger.log("wait for account tile timed out");
    return false;
  }

  return true;
  // TODO check if we logged in successfully
  // if 2nd factor page is shown, this can be detected by checking for the existence of
  // button#requestDeliveryDevices
  // also h3 with innerText = "We don't recognize the computer you're using."
}

async function performRequests(page, logger) {
  const cookies = await page.cookies();

  logger.log("/tiles/list START");
  const appDataRaw: string = await new Promise(function (resolve, reject) {
    const body = "cache=1"; // This is required. (probably just a non empty body is required
    var response = "";
    const req = https.request({
      hostname: 'secure05c.chase.com',
      port: 443,
      path: '/svc/rl/accounts/secure/v1/app/data/list',
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json',
        'Cookie': cookies.map((a) => a.name + '=' + a.value).join('; '),
        'x-jpmc-csrf-token': 'NONE'
      }
    }, function (res) {
      res.setEncoding('utf8');
      res.on('data', (chunk) => { response = response + chunk });
      res.on('end', () => resolve(response));
    });
    req.on('error', (e) => reject("/tiles/list failed with: " + JSON.stringify(e)))
    req.write(body);
  });
  logger.log({ appDataRaw: appDataRaw });

  var accountTiles;
  try {
    accountTiles = JSON.parse(appDataRaw).cache.find((a) => a.url == "/svc/rr/accounts/secure/v4/dashboard/tiles/list").response.accountTiles;
  } catch (e) {
    logger.log(`failed to parse accountTiles JSON: ${e}`);
    const iframescreenshot = await page.evaluate(() => window.frames[0].document.body.innerHTML);
    logger.log({ iframescreenshot });
    throw "Probably Chase \"2nd factor\" required";
  }

  for (var i = 0; i < accountTiles.length; i++) {
    logger.log(`/card/list[${i}] START`);

    const jsonTransactions: string = await new Promise(function (resolve, reject) {
      const body = `accountId=${accountTiles[i].accountId}&filterTranType=ALL&statementPeriodId=ALL`;
      var response = "";
      const req = https.request({
        hostname: 'secure05c.chase.com',
        port: 443,
        path: '/svc/rr/accounts/secure/v1/account/activity/card/list',
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Accept': 'application/json',
          'Cookie': cookies.map((a) => a.name + '=' + a.value).join('; '),
          'x-jpmc-csrf-token': 'NONE'
        }
      }, function (res) {
        res.setEncoding('utf8');
        res.on('data', (chunk) => { response = response + chunk });
        res.on('end', () => resolve(response));
      });
      req.on('error', (e) => reject(`/card/list[${i}] failed with: ` + e.toString()))
      req.write(body);
    });
    logger.log(`/card/list[${i}] END`);
    logger.log({ jsonTransactions: jsonTransactions });
    const parsedTs = JSON.parse(jsonTransactions);
    // TODO: if transactions.status == 504 there was a temporary failure. Retry ?
    if (parsedTs.status && parsedTs.status == 403) {
      throw "wtf, still not signed in???";
    }
    accountTiles[i].transactions = parsedTs;
  }
  return accountTiles;
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
    userDataDir: "chase-" + creds.username,
    executablePath: '/k/gits/money-scraper/node_modules/puppeteer/.local-chromium/linux-895174/chrome-linux/chrome'
  });
  const page = await browser.newPage();

  await page._client.send('Page.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: DOWNLOAD_DIR
  });

  // await page.setViewport({ width: 1920, height: 1080 });

  function sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  try {
    var numTries = 5;
    var success = false;
    while (numTries >= 0) {
      success = false;
      try {
        success = await login(page, creds, logger);
      } catch (e) {
        logger.log({
          msg: `LOGIN FAILED; numTries = ${numTries}`,
          exception: (e.toString() === "[object Object]") ? JSON.stringify(e) : e.toString(),
        });
      }
      if (success) break;
      numTries--;
    }

    if (success == false) {
      throw "failed to login";
    }

    const accountTiles = await performRequests(page, logger);

    return {
      ok: true,
      accountTiles: accountTiles,
      log: logger.getLog()
    };
  } catch (e) {
    var screenshot, domscreenshot;
    try {
      screenshot = (await page.screenshot()).toString('base64');
      domscreenshot = await page.evaluate(() => document.querySelector("body").innerHTML);
    } catch (e) {
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

export default {
  scrape
}