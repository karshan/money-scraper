class Logger {
  debug: boolean;
  buffer: Array<Object>
  constructor(logToConsole: boolean) {
    this.debug = logToConsole;
    this.buffer = [];
  }

  log(m: Object | string) {
    var logObj: Object;
    var ts = new Date();
    if (typeof m === "string") {
      logObj = { timestamp: ts, msg: m };
    } else {
      const o = m as { timestamp: string };
      o.timestamp = ts.toString();
      logObj = o;
    }

    this.buffer.push(logObj)

    if (this.debug === true) {
      if (typeof m === "string") {
        console.log(m);
      } else {
        console.log(JSON.stringify(m, null, 2).substring(0, 2000));
      }
    }
  }

  getLog() {
    return this.buffer;
  }
}

export default Logger;
