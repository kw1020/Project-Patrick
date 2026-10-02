// Usage: npm run reset-code -- CUSTOMER_CODE
import { resetCode } from "./licenses.js";

const code = process.argv[2];
if (!code) {
  console.log("Usage: npm run reset-code -- CUSTOMER_CODE");
  process.exit(1);
}
console.log(resetCode(code) ? `Unlocked "${code}". The next device that uses it gets locked in.` : `No device was locked to "${code}".`);
