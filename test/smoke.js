#!/usr/bin/env node
/*
 * Browser smoke test: drives the real two-phone flow in headless Chromium —
 * tap out a move, harvest the produced link, reopen it as the opponent, and
 * repeat through checkmate, promotion, draw offers, and corrupt links.
 *
 * Needs playwright (`npm i playwright && npx playwright install chromium`).
 * Run:  node test/smoke.js
 */
"use strict";

var http = require("http");
var fs = require("fs");
var path = require("path");
var assert = require("assert");

var chromium;
try {
  chromium = require("playwright").chromium;
} catch (error) {
  console.error("playwright is not installed — run: npm i playwright && npx playwright install chromium");
  process.exit(2);
}

var ROOT = path.join(__dirname, "..");
var TYPES = { ".html": "text/html", ".js": "text/javascript" };

function serve() {
  return new Promise(function (resolve) {
    var server = http.createServer(function (req, res) {
      var name = req.url.split("?")[0].split("#")[0];
      if (name === "/") name = "/index.html";
      var file = path.join(ROOT, path.normalize(name).replace(/^([.][.][/\\])+/, ""));
      fs.readFile(file, function (error, data) {
        if (error) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      });
    });
    server.listen(0, "127.0.0.1", function () {
      resolve({ server: server, base: "http://127.0.0.1:" + server.address().port + "/" });
    });
  });
}

// 0x88 index for a square name, matching engine.js and the data-sq attributes.
function sq(name) {
  return (name.charCodeAt(1) - 49) * 16 + (name.charCodeAt(0) - 97);
}

async function tapMove(page, from, to) {
  await page.click('.sq[data-sq="' + sq(from) + '"]');
  await page.click('.sq[data-sq="' + sq(to) + '"]');
}

async function stagedLink(page) {
  var link = await page.textContent("#linkPeek");
  assert.ok(link.indexOf("#v=1") !== -1, "staged link has a payload: " + link);
  return link.trim();
}

async function main() {
  var served = await serve();
  var browser = await chromium.launch();
  var page = await browser.newPage();
  var passed = 0;
  function ok(label) {
    passed += 1;
    console.log("  ✓ " + label);
  }

  // Landing → new game → first move staged.
  await page.goto(served.base);
  assert.ok(await page.isVisible("#landing"), "landing visible");
  ok("landing renders");
  await page.click("#newGameBtn");
  assert.ok((await page.textContent("#statusLine")).indexOf("you're White") !== -1);
  ok("fresh game seats the starter as White");

  await tapMove(page, "e2", "e4");
  assert.ok(await page.isVisible("#sendPanel"), "send panel visible");
  var link1 = await stagedLink(page);
  assert.ok(link1.indexOf("#v=1&m=e2e4") !== -1, "link encodes the move: " + link1);
  var caption = await page.textContent("#sendCaption");
  assert.ok(caption.indexOf("1. e4") !== -1, "caption mentions the move: " + caption);
  ok("White's move stages a v1-format link");

  // Undo restores the live board.
  await page.click("#undoBtn");
  assert.ok(await page.isVisible("#actionBar"), "action bar back after undo");
  ok("undo unstages");
  await tapMove(page, "e2", "e4");
  link1 = await stagedLink(page);

  // "Phone two": open the link, reply as Black.
  await page.goto(link1);
  assert.ok((await page.textContent("#statusLine")).indexOf("you're Black") !== -1);
  assert.ok((await page.textContent("#statusDetail")).indexOf("1. e4") !== -1);
  ok("opening the link seats the receiver as Black");
  await tapMove(page, "e7", "e5");
  var link2 = await stagedLink(page);
  assert.ok(link2.indexOf("m=e2e4,e7e5") !== -1, "both moves ride the link");
  ok("Black's reply extends the move list");

  // Fool's mate across four link hops, checking the checkmate UX.
  await page.goto(served.base);
  await page.click("#newGameBtn");
  await tapMove(page, "f2", "f3");
  var foolish = await stagedLink(page);
  await page.goto(foolish);
  await tapMove(page, "e7", "e5");
  foolish = await stagedLink(page);
  await page.goto(foolish);
  await tapMove(page, "g2", "g4");
  foolish = await stagedLink(page);
  await page.goto(foolish);
  await tapMove(page, "d8", "h4");
  caption = await page.textContent("#sendCaption");
  assert.ok(caption.indexOf("Checkmate") !== -1, "mate caption: " + caption);
  foolish = await stagedLink(page);
  await page.goto(foolish);
  assert.ok((await page.textContent("#statusLine")).indexOf("Checkmate — Black wins") !== -1);
  assert.ok(await page.isVisible("#rematchBtn"), "rematch offered");
  ok("fool's mate: mate staged, sent, and shown to the loser");

  // Rematch produces an empty-game link that seats the opener as White.
  await page.click("#rematchBtn");
  var rematch = await stagedLink(page);
  await page.goto(rematch);
  assert.ok((await page.textContent("#statusLine")).indexOf("you're White") !== -1);
  ok("rematch link hands White to whoever opens it");

  // Promotion: set up a capture-promotion and use the picker.
  await page.goto(served.base + "#v=1&m=a2a4,b7b5,a4b5,a7a6,b5a6,h7h6,a6a7,g7g6");
  await tapMove(page, "a7", "b8");
  assert.ok(await page.isVisible("#promoOverlay"), "promotion picker shown");
  await page.click("#promoChoices button:first-child"); // queen
  var promoLink = await stagedLink(page);
  assert.ok(promoLink.indexOf("a7b8q") !== -1, "promotion encoded: " + promoLink);
  ok("promotion picker stages axb8=Q");

  // Draw offer riding a move, then acceptance.
  await page.goto(served.base + "#v=1&m=e2e4");
  await page.click("#offerDrawBtn");
  await tapMove(page, "e7", "e5");
  var offerLink = await stagedLink(page);
  assert.ok(offerLink.indexOf("do=b") !== -1, "draw offer rides the link: " + offerLink);
  await page.goto(offerLink);
  assert.ok(await page.isVisible("#drawBanner"), "offer banner shown to opponent");
  await page.click("#acceptDrawBtn");
  var agreeLink = await stagedLink(page);
  assert.ok(agreeLink.indexOf("da=1") !== -1, "agreement encoded");
  await page.goto(agreeLink);
  assert.ok((await page.textContent("#statusLine")).indexOf("Draw") !== -1);
  ok("draw offer → accept → agreed draw");

  // Resignation.
  await page.goto(served.base + "#v=1&m=e2e4");
  page.once("dialog", function (dialog) { dialog.accept(); });
  await page.click("#resignBtn");
  var resignLink = await stagedLink(page);
  assert.ok(resignLink.indexOf("rb=b") !== -1, "resignation encoded");
  await page.goto(resignLink);
  assert.ok((await page.textContent("#statusLine")).indexOf("White wins") !== -1);
  ok("resignation flows through");

  // Corrupt and tampered links are refused.
  await page.goto(served.base + "#v=1&m=e2e4,e2e4");
  assert.ok(await page.isVisible("#corrupt"), "tampered link refused");
  await page.goto(served.base + "#garbage");
  assert.ok(await page.isVisible("#corrupt"), "garbage link refused");
  ok("corrupt links land on the error screen");

  await browser.close();
  served.server.close();
  console.log("\nSmoke test: all " + passed + " scenarios passed.");
}

main().catch(function (error) {
  console.error(error);
  process.exit(1);
});
