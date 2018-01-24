const fs = require('fs');

function debug(x) {
  console.log("DEBUG: " + x);
}

// log network requests made by puppeteer
// usage: page.on('response', responseLogger);
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

// wait for an element identified by a CSS selector (sel) in an iframe (frame)
// to appear and then click it. frame: puppeteer.Frame
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

// wait for an element identified by a CSS selector (sel) in a puppeteer page
// to appear and then click it.
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
  return promiseTimeout(30000, new Promise(function(resolve, reject) {
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

function waitForFileCreation(dir, fileRegex) {
  debug(`waitForFileCreation START ${dir}, ${fileRegex}`);
  return promiseTimeout(30000, new Promise(function(resolve, reject) {
    const watcher = fs.watch(dir, (eventType, filename) => {
      if (eventType == "change" && fileRegex.test(filename)) {
        watcher.close();
        debug(`waitForFileCreation END ${filename}`);
        resolve(filename);
      }
    });
  }));
}

module.exports = {
  responseLogger: responseLogger,
  frameWaitAndClick: frameWaitAndClick,
  waitAndClick: waitAndClick,
  promiseTimeout: promiseTimeout,
  waitForResponse: waitForResponse,
  waitForUrlRegex: waitForUrlRegex,
  waitForFileCreation: waitForFileCreation,
  debug: debug
}
