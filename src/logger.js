//@flow
class Logger {
  debug: boolean;
  buffer: Array<Object>
    constructor(logToConsole: boolean) {
      this.debug = logToConsole;
      this.buffer = [];
    }

    log(m: Object | string) {
      var logObj;
      var ts = new Date();
      if (typeof m === "string") {
        logObj = { timestamp: ts, msg: m };
      } else {
        const o: { timestamp: string } = (m : Object);
        o.timestamp = ts.toString();
        logObj = o;
      }

      this.buffer.push(logObj)

      if (this.debug === true) {
        if (typeof m === "string") {
          console.log(m);
        } else {
          console.log(JSON.stringify(m, null, 2));
        }
      }
    }

    getLog() {
      return this.buffer;
    }
}
module.exports = Logger;
