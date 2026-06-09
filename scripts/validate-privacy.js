const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

const publicHtmlFiles = fs.readdirSync(root).filter((file) => file.endsWith(".html"));

const errors = [];

if (fs.existsSync(path.join(root, "resume.html"))) {
  errors.push("根目录仍存在 resume.html");
}

for (const file of publicHtmlFiles) {
  const content = fs.readFileSync(path.join(root, file), "utf8");

  if (/resume\.html/i.test(content)) {
    errors.push(`${file} 仍包含简历页引用`);
  }
}

if (errors.length) {
  console.error("隐私检查失败：");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("隐私检查通过：未发现简历页或简历入口。");
