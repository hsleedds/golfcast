// Roundcast 업로드 자동 점검 — GitHub Actions에서 실행 (사이트 동작에는 영향 없음)
// index.html을 브라우저로 열어 앱 안의 자동 검사(rcSelfTest)를 돌리고, 실패·오류가 있으면 점검 실패로 표시합니다.
import { chromium } from "playwright";
import http from "node:http";
import { readFile } from "node:fs/promises";

const html = await readFile(process.argv[2] || "index.html");
const srv = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html; charset=utf-8" }); r.end(html); });
await new Promise(ok => srv.listen(0, "127.0.0.1", ok));
const url = `http://127.0.0.1:${srv.address().port}/index.html`;

const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 390, height: 844 } });
const errs = [];
pg.on("pageerror", e => errs.push(String(e)));
await pg.route("**/*", r => r.request().url().startsWith(url.split("/index")[0]) ? r.continue() : r.abort()); // 외부 서버(날씨 등)는 막고 앱만 점검
await pg.goto(url);
await pg.waitForTimeout(1500);

const ver = (html.toString().match(/v\d{4}\.\d{2}\.\d{2}[a-z]/) || ["(버전 없음)"])[0];
const hasTest = await pg.evaluate(() => typeof window.rcSelfTest === "function");
const res = hasTest ? await pg.evaluate(() => window.rcSelfTest()) : [];
const bad = res.filter(x => !x.ok);
await b.close(); srv.close();

console.log(`Roundcast ${ver} · 자동 검사 ${res.length - bad.length}/${res.length} 통과`);
bad.forEach(x => console.log(`  ✗ ${x.name} — 결과 ${JSON.stringify(x.got)} 기대 ${JSON.stringify(x.exp)}`));
errs.forEach(e => console.log(`  ✗ 화면 오류: ${e}`));
if (!hasTest) console.log("  ✗ 자동 검사 기능을 찾지 못했습니다 (index.html이 잘못 올라갔을 수 있음)");
process.exit(!hasTest || bad.length || errs.length ? 1 : 0);
