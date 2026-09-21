const Database=require("better-sqlite3");
const db=new Database("F:/Coding/zalo-mcp/.zalo-test-home/.zalo-agent-cli/accounts/1911679535470292669/zalo.db",{readonly:true});
console.log("total", db.prepare("SELECT COUNT(*) c FROM messages").get().c);
console.log("by src", db.prepare("SELECT json_extract(raw_data,'$.src') src, COUNT(*) c FROM messages WHERE json_valid(raw_data) GROUP BY 1 ORDER BY 2 DESC").all());
for (const f of ["quote","mentions","reference","property","ttl"]) {
  const r=db.prepare("SELECT json_extract(raw_data,'$.src') src, COUNT(*) c FROM messages WHERE json_valid(raw_data) AND json_extract(raw_data,'$."+f+"') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC").all();
  console.log(f.padEnd(10), JSON.stringify(r));
}
