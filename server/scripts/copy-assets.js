const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "src", "api", "public");
const dest = path.join(__dirname, "..", "dist", "api", "public");

fs.cpSync(src, dest, { recursive: true });
console.log(`Copiado ${src} -> ${dest}`);
