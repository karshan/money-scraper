import puppeteer from 'puppeteer'
import util from './util'
import Logger from './logger'

const DOWNLOAD_DIR = './downloads/';
const CSV_REGEX = new RegExp("\.csv$", "i");

// LoginPage Url
const LOGIN_PAGE_URL = 'https://www.americanexpress.com/';

// login page
const SIGN_IN_BUTTON_SEL = "#gnav_login"
const SIGN_IN_SUBMIT_BUTTON_SEL = "#loginSubmit"
const USERNAME_SEL = "#eliloUserID";
const PASSWORD_SEL = "#eliloPassword";

const ACCOUNTS_SEL = '[title="Statements & Activity"]'

const TRANSACTION_SEL = '.btn-icon.dls-icon-download'

const CSV_SEL = '#axp-activity-download-body-selection-options-type_csv'

const DOWNLOAD_TRANSACTION_SEL = '[title="Download"]'

type StateTag = "INITIAL" | "LOGIN2" | "DONE" | "ACCOUNTS" | "TRANSACTIONS"
type State = { tag: StateTag, numAttempts: number }

type Creds = { username: string, password: string, secretQuestionAnswers: Object }

async function login(state: State, page, creds, logger: Logger): Promise<{ state: State, output: any }> {
    try {
        await page.goto(LOGIN_PAGE_URL);
    } catch (e) {
        logger.log('initial nav timed out');
    }

    await page.waitFor(10000);

    await Promise.all([
        page.waitForNavigation(),
        util.waitAndClick(page, SIGN_IN_BUTTON_SEL, logger)
    ]);

    const pageAfterLogin = await Promise.race([
        page.waitForSelector(USERNAME_SEL).then((r) => "LOGIN2"),
    ])

    return { state: { tag: pageAfterLogin, numAttempts: state.numAttempts }, output: null }
}

async function login2(state: State, page, creds, logger: Logger): Promise<{ state: State, output: any }> {

    await util.waitAndClick(page, USERNAME_SEL, logger);
    logger.log(USERNAME_SEL + ' resolved');
    await page.keyboard.type(creds.username);

    await util.waitAndClick(page, PASSWORD_SEL, logger);
    await page.keyboard.type(creds.password);

    await Promise.all([
        page.waitForNavigation(),
        util.waitAndClick(page, SIGN_IN_SUBMIT_BUTTON_SEL, logger)
    ]);

    const pageAfterLogin = await page.waitForSelector(ACCOUNTS_SEL).then((r) => "ACCOUNTS")

    return { state: { tag: pageAfterLogin, numAttempts: state.numAttempts }, output: null }
}

async function accounts(state: State, page, logger: Logger): Promise<{ state: State, output: any }> {

    await Promise.all([
        page.waitForNavigation(),
        util.waitAndClick(page, ACCOUNTS_SEL, logger)
    ]);

    const pageAfterLogin = await page.waitForSelector(TRANSACTION_SEL).then((r) => "TRANSACTIONS")

    return { state: { tag: pageAfterLogin, numAttempts: state.numAttempts }, output: null }
}

async function performDownloads(state, page, logger): Promise<{ state: State, output: any }> {

    const balanceText = await page.evaluate(`document.querySelector('div[data-module-name="axp-activity-vitals-total-lg"]').innerText`)
    const exactBalance = balanceText.substring(balanceText.indexOf('$'))

    const nameBalance = {
        name: 'AMEX',
        balance: exactBalance,
        accountId: 1
    };

    var downloadedData = []

    await util.waitAndClick(page, TRANSACTION_SEL, logger);
    await page.waitFor(3000)

    await page.waitForSelector(CSV_SEL)
    await util.waitAndClick(page, CSV_SEL, logger);

    const fileCreationP = util.waitForFileCreation(DOWNLOAD_DIR, CSV_REGEX, logger);
    await util.waitAndClick(page, DOWNLOAD_TRANSACTION_SEL, logger);
    var csvFilename = null;
    var csvContents = null;
    try {
        csvFilename = await fileCreationP;
    } catch (e) {
        logger.log(e);
    }
    if (csvFilename) {
        csvContents = (await util.readFile(DOWNLOAD_DIR + csvFilename)).toString();
        await util.unlink(DOWNLOAD_DIR + csvFilename);
    }

    downloadedData.push({
        name: nameBalance.name,
        balance: nameBalance.balance,
        accountId: nameBalance.accountId,
        csv: csvContents
    });

    return { state: { tag: "DONE", numAttempts: state.numAttempts }, output: downloadedData }
}

// TODO annotate return type
async function scrape(creds: Creds) {
    if (typeof creds.username !== "string" ||
        typeof creds.password !== "string") {
        return { ok: false, error: 'bad creds' };
    }

    var logger = new Logger(true, "AMEX<" + creds.username + ">");

    /*
     * TODO: is a fixed userDataDir safe for concurrent use ?
     * removing the userDataDir option will make it so a temporary profile
     * dir is used instead which is deleted on browser.close(). This means
     * cookies and browser cache will not be saved.
     */
    const browser = await puppeteer.launch({
        headless: false,
        userDataDir: "amex-" + creds.username
    });
    const page = await browser.newPage();

    //  await page.setUserAgent(USER_AGENT);

    // FIXME a fixed download_dir is a problem for concurrent requests
    // because headless chrome doesn't download to filename (1) if
    // filename exists for some reason.
    // @ts-ignore: Private member access error
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
            switch (state.tag) {
                case "INITIAL":
                    ({ state, output } = await login(state, page, creds, logger));
                    break;
                case "LOGIN2":
                    ({ state, output } = await login2(state, page, creds, logger));
                    break;
                case "ACCOUNTS":
                    ({ state, output } = await accounts(state, page, logger));
                    break;
                case "TRANSACTIONS":
                    ({ state, output } = await performDownloads(state, page, logger));
                    break;
            }
        }
        return {
            ok: true,
            downloadedData: output,
            log: logger.getLog()
        };
    } catch (e) {
        var screenshot, domscreenshot;
        try {
            screenshot = (await page.screenshot() as any).toString('base64');
            domscreenshot = await page.evaluate(`document.querySelector("body").innerHTML`);
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
