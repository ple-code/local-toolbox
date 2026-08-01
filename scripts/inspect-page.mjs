#!/usr/bin/env node
import { ChromePdfSession } from "../lib/chrome-pdf.mjs";

const url = process.argv[2];
if (!url) {
  console.error("Usage: node scripts/inspect-page.mjs <url>");
  process.exit(1);
}

const session = new ChromePdfSession({
  profileDir: process.env.CHROME_PROFILE_DIR || ".chrome-profile",
  waitMs: Number(process.env.WAIT_MS || 3000),
  keepBrowser: process.env.KEEP_BROWSER === "1",
  log: (message, meta) => console.error(message, JSON.stringify(meta || {}))
});

try {
  const tab = await session.open(url);
  const result = await tab.cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `new Promise(async (resolve) => {
      const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
      await sleep(3000);
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 20 && rect.height > 20 && style.display !== 'none' && style.visibility !== 'hidden';
      };
      const label = (node) => {
        const className = typeof node.className === 'string' ? node.className : '';
        return [
          node.tagName.toLowerCase(),
          node.id ? '#' + node.id : '',
          className ? '.' + className.trim().replace(/\\s+/g, '.') : ''
        ].join('');
      };
      const summarize = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          label: label(node),
          textLength: (node.innerText || '').trim().length,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            bottom: Math.round(rect.bottom)
          },
          scrollHeight: node.scrollHeight,
          clientHeight: node.clientHeight,
          overflowY: style.overflowY,
          position: style.position
        };
      };
      const nodes = Array.from(document.querySelectorAll('body *')).filter(visible);
      const scrollables = nodes
        .filter((node) => node.scrollHeight > node.clientHeight + 80)
        .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))
        .slice(0, 20)
        .map(summarize);
      const textCandidates = nodes
        .filter((node) => (node.innerText || '').trim().length > 1000)
        .sort((a, b) => (b.innerText || '').trim().length - (a.innerText || '').trim().length)
        .slice(0, 20)
        .map(summarize);
      resolve({
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        page: {
          bodyScrollHeight: document.body?.scrollHeight || 0,
          documentScrollHeight: document.documentElement?.scrollHeight || 0,
          bodyClientHeight: document.body?.clientHeight || 0,
          documentClientHeight: document.documentElement?.clientHeight || 0,
          bodyTextLength: (document.body?.innerText || '').trim().length
        },
        scrollables,
        textCandidates
      });
    })`
  }, tab.sessionId, 15000);
  console.log(JSON.stringify(result.result.value, null, 2));
  await session.closeTab(tab);
} finally {
  await session.close();
}
