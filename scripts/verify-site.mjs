#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const HTML_FILES = ["index.html", "assessments.html", "placement.html"];
const SKIP_DIRS = new Set([".git", "node_modules"]);
const TEXT_EXTENSIONS = new Set([
  ".html", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json",
  ".yml", ".yaml", ".md", ".css", ".toml", ".sql"
]);
const failures = [];
const warnings = [];

function pass(message) {
  console.log("✓ " + message);
}

function fail(message) {
  failures.push(message);
  console.error("✗ " + message);
}

function warn(message) {
  warnings.push(message);
  console.warn("⚠ " + message);
}

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function assertContains(content, expected, message) {
  if (content.includes(expected)) pass(message);
  else fail(message);
}

function assertNotContains(content, forbidden, message) {
  if (!content.includes(forbidden)) pass(message);
  else fail(message);
}

function extractInlineScripts(html) {
  const scripts = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    const attributes = match[1];
    if (/\bsrc\s*=/.test(attributes)) continue;
    const type = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1];
    if (type && !["text/javascript", "application/javascript", "module"].includes(type)) continue;
    scripts.push(match[2]);
  }
  return scripts;
}

function checkInlineJavaScript(file, html) {
  const scripts = extractInlineScripts(html);
  if (scripts.length === 0) {
    fail(file + " has no inline JavaScript to validate");
    return;
  }
  scripts.forEach((source, index) => {
    try {
      new Function(source);
      pass(file + " inline script " + (index + 1) + " parses");
    } catch (error) {
      fail(file + " inline script " + (index + 1) + " has invalid JavaScript: " + error.message);
    }
  });
}

function isExternalOrDynamic(target) {
  return (
    target === "" ||
    target.startsWith("#") ||
    target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("${") ||
    /^(?:https?:|mailto:|tel:|data:|javascript:)/i.test(target)
  );
}

function checkRelativeLinks(file, html) {
  const pattern = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
  let match;
  let checked = 0;
  while ((match = pattern.exec(html))) {
    const original = match[1].trim();
    if (isExternalOrDynamic(original)) continue;
    const clean = original.split("#")[0].split("?")[0];
    if (!clean) continue;
    let decoded = clean;
    try {
      decoded = decodeURIComponent(clean);
    } catch {
      fail(file + ' contains an invalid encoded link: "' + original + '"');
      continue;
    }
    const resolved = path.resolve(ROOT, path.dirname(file), decoded);
    if (!resolved.startsWith(ROOT + path.sep)) {
      fail(file + ' link escapes the repository: "' + original + '"');
    } else if (!fs.existsSync(resolved)) {
      fail(file + ' points to a missing local file: "' + original + '"');
    } else {
      checked++;
    }
  }
  pass(file + " local links checked (" + checked + ")");
}

function collectTextFiles(directory, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) collectTextFiles(absolute, results);
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) results.push(absolute);
  }
  return results;
}

function checkForSecrets() {
  const patterns = [
    ["Stripe secret key", /\bsk_(?:test|live)_[A-Za-z0-9]{16,}\b/g],
    ["Stripe webhook secret", /\bwhsec_[A-Za-z0-9]{16,}\b/g],
    ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g]
  ];
  let scanned = 0;
  for (const absolute of collectTextFiles(ROOT)) {
    const relative = path.relative(ROOT, absolute);
    const content = fs.readFileSync(absolute, "utf8");
    scanned++;
    for (const [label, pattern] of patterns) {
      pattern.lastIndex = 0;
      if (pattern.test(content)) fail(label + " appears committed in " + relative);
    }
  }
  pass("credential patterns checked across " + scanned + " text files");
}

for (const file of HTML_FILES) {
  if (!fs.existsSync(path.join(ROOT, file))) {
    fail("required page is missing: " + file);
    continue;
  }
  const html = read(file);
  checkInlineJavaScript(file, html);
  checkRelativeLinks(file, html);
}

checkForSecrets();

const index = read("index.html");
assertContains(index, "const MAX_SESSIONS = 4;", "booking remains capped at four sessions");
assertNotContains(index, "MAX_SESSIONS = 12", "legacy 12-session limit is absent");
assertContains(
  index,
  "Booking is temporarily unavailable because live availability could not be confirmed.",
  "booking fails closed when live availability cannot be confirmed"
);

const placement = read("placement.html");
assertContains(placement, "function escapeHtml", "placement result names are escaped");
assertContains(placement, 'id="reg-consent"', "placement requires parent/guardian consent");
assertNotContains(placement, "placementRegistration", "placement avoids duplicate direct registration delivery");
assertContains(placement, "<span class=\"icon\">30</span>Minutes", "placement duration is displayed as 30 minutes");

const assessments = read("assessments.html");
assertContains(assessments, "function escapeHtml", "assessment result names are escaped");
assertContains(assessments, "30-question", "assessment question count is displayed accurately");
assertNotContains(assessments, "${state.name}", "assessment results do not interpolate an unescaped student name");

if (assessments.includes('const PASS = "UpAndUp2026";')) {
  warn("assessments.html still uses the known static access-code gate; backend authentication is the next security chunk");
}

console.log("");
if (failures.length > 0) {
  console.error(failures.length + " verification check(s) failed.");
  process.exit(1);
}
console.log("All repository verification checks passed" + (warnings.length ? " with " + warnings.length + " known warning." : "."));
