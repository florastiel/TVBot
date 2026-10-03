// Where Puppeteer looks for (and installs) its Chrome. The default is ~\.cache\puppeteer of
// whoever is running, so the bot and player running as another account (the SYSTEM service)
// couldn't find the Chrome installed under a user's profile and the weather report failed
// every time. Inside the project every account sees the same one (tools\ is not in git):
//   npx puppeteer browsers install chrome-headless-shell
const { join } = require("node:path");

module.exports = { cacheDirectory: join(__dirname, "tools", "puppeteer-cache") };
