#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ChromePdfSession,
  DEFAULT_URL,
  defaultOutputFor,
  normalizeUrl,
  sleep
} from "../lib/chrome-pdf.mjs";

function parseArgs(argv) {
  const args = {
    url: undefined,
    output: undefined,
    profileDir: ".chrome-profile",
    pause: true,
    waitMs: 2000,
    keepBrowser: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "-o" || arg === "--output") {
      args.output = argv[++index];
    } else if (arg === "--profile-dir") {
      args.profileDir = argv[++index];
    } else if (arg === "--no-pause") {
      args.pause = false;
    } else if (arg === "--wait-ms") {
      args.waitMs = Number(argv[++index]);
    } else if (arg === "--keep-browser") {
      args.keepBrowser = true;
    } else if (!args.url) {
      args.url = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  args.url ||= DEFAULT_URL;
  if (!Number.isFinite(args.waitMs) || args.waitMs < 0) {
    throw new Error("--wait-ms must be a non-negative number.");
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node ./bin/html2pdf.mjs [url] [options]

Options:
  -o, --output <path>       PDF output path
  --profile-dir <path>      Chrome profile directory (default: .chrome-profile)
  --no-pause                Do not wait for manual login/confirmation
  --wait-ms <number>        Extra wait after page load, in milliseconds (default: 2000)
  --keep-browser            Leave Chrome open after generating the PDF
  -h, --help                Show this help

Default URL:
  ${DEFAULT_URL}`);
}

async function promptToContinue(url) {
  const rl = createInterface({ input, output });
  try {
    console.log("");
    console.log("Chrome is open. Log in if needed and make sure the article content is visible.");
    console.log(`URL: ${url}`);
    await rl.question("Press Enter here to generate the PDF...");
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const url = normalizeUrl(args.url);
  const outPath = path.resolve(args.output || defaultOutputFor(url));
  await mkdir(path.dirname(outPath), { recursive: true });

  console.log(`Starting Chrome with profile: ${path.resolve(args.profileDir)}`);
  const session = new ChromePdfSession({
    profileDir: args.profileDir,
    waitMs: args.waitMs,
    keepBrowser: args.keepBrowser
  });

  try {
    console.log(`Opening: ${url}`);
    if (args.pause) {
      await session.openForLogin(url, { waitMs: args.waitMs });
      await promptToContinue(url);
      await sleep(args.waitMs);
    }

    console.log("Preparing page and generating PDF...");
    const pdf = await session.pdfForUrl(url, { waitMs: args.waitMs });
    await writeFile(outPath, pdf);
    console.log(`PDF written: ${outPath}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
});
