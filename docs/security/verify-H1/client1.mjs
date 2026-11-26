const port = process.argv[2];
const t0 = Date.now(); const c0 = process.cpuUsage();
const rep = () => { const c = process.cpuUsage(c0); console.log(JSON.stringify({ t: ((Date.now()-t0)/1000)|0, cpu_s: ((c.user+c.system)/1e6).toFixed(2), rss_mb: (process.memoryUsage().rss/1048576).toFixed(0) })); };
const iv = setInterval(rep, 5000);
setTimeout(() => { rep(); console.log("still pending after 20s"); process.exit(0); }, 20500);
fetch(`http://127.0.0.1:${port}/`).then(r => r.text()).then(t => { console.log("resolved", t.length); process.exit(0); }, e => { console.log("rejected", e.code ?? e.message); process.exit(0); });
