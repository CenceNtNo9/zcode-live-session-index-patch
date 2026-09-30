"use strict";

require(process.env.ZCODE_ISOLATED_GUARD);

let networkBlocked = false;
let outsideReadBlocked = false;
try {
  require("node:net").connect(0, "127.0.0.1");
} catch (error) {
  networkBlocked = error?.code === "ZCODE_ISOLATION_BLOCKED";
}
try {
  require("node:fs").readFileSync(process.env.ZCODE_ISOLATED_DENY_FIXTURE_FILE);
} catch (error) {
  outsideReadBlocked = error?.code === "ZCODE_ISOLATION_BLOCKED";
}

process.parentPort.postMessage({ type: "guard-probe", networkBlocked, outsideReadBlocked });
setTimeout(() => process.exit(networkBlocked && outsideReadBlocked ? 0 : 2), 25);
