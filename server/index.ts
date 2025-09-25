import Database from "bun:sqlite";
import { pipeline, Tensor } from "@xenova/transformers";
import type { BunRequest } from "bun";
import { getLoadablePath } from "sqlite-vec";

const embedder = await pipeline(
  "feature-extraction",
  "Xenova/all-MiniLM-L6-v2",
);

// Fuck you apple
// https://bun.com/docs/api/sqlite#loadextension
Database.setCustomSQLite(
  "/opt/homebrew/Cellar/sqlite/3.50.4/lib/libsqlite3.dylib",
);

const db = new Database("dev.db", { create: true });
db.loadExtension(getLoadablePath());
const { vec_version } = db
  .prepare("select vec_version() as vec_version;")
  .get();
console.log(`vec_version=${vec_version}`);

db.run(`
  CREATE TABLE IF NOT EXISTS records (
    record_id INTEGER PRIMARY KEY,
    created_at DATETIME,
    url TEXT,
    title TEXT,
    content BLOB
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS vecs using vec0(
    record_id INTEGER,
    start INTEGER,
    end INTEGER,
    embedding float[384]
  );
`);

interface Record {
  record_id: number,
  url: string,
  start: number,
  end: number,
  title: string,
  distance: number,
}

async function search(query: string): Promise<Record[]> {
      const embedding = await embedder(query);
      const bindings = JSON.stringify(embedding.tolist()[0][0]);
      console.log("bindings", bindings);
      const result:Record[] = db
        .query(
          `
select Q.record_id,
       start,
       end,
       url,
       title,
       substr(content, start, end) as snippet,
       min(distance) as distance
from (
    select record_id, start, end, distance
    from vecs
    where embedding match ?
    order by distance asc
    limit 100
) as Q
join records on records.record_id = Q.record_id
group by Q.record_id
order by distance asc
limit 5
        `,
        )
        .all(bindings);
        return result;
}

const result = Bun.serve({
  port: 1729,

  routes: {
    "/": async (req: BunRequest) => {
      let results:Record[] = [];
      if (req.method === "POST") {
        const params = new URLSearchParams( await req.text())
        const query=params.get("query")
      if (!query) return Response.error();
        results = await search(query);
      }
      
      return new Response(`
      <style>
        ul { display: flex; flex-direction: column; list-style-type: none; padding: 0; gap: 1rem; }
        ul.list li { border: 1px solid gray; padding: 1rem; }
        ul.list li h3 { margin: 0; }
      </style>
      <div class=container> <form method=POST>
        <input type=text name=query placeholder="Search..." />
        ${results && `<ul class=list>${results.map(result => `<li><a href="${result.url}" target=_blank rel=noopener><h3>${result.title}</h3><small>${result.url}</small></a><p>${result.snippet}</p>`)}</ul>`}
      </form> </div>
    `, {headers: {"Content-Type": "text/html"}})
  },

    "/api/search": async (req: BunRequest) => {
      const url = new URL(req.url);
      const query = url.searchParams.get("query");
      if (!query) return Response.error();
      return Response.json(result);
    },

    "/api/store": async (req: BunRequest) => {
      if (req.method === "OPTIONS") {
        return new Response("", {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      const result = db.transaction(async () => {
        const data = await req.text();
        console.log("Data", JSON.parse(data).content);
        const { content, title, url } = JSON.parse(data);

        const vecs: [Tensor, number, number][] = [];
        {
          const windowSize = 1024;
          let i = 0;
          const promises = [];
          while (i < content.length) {
            const start = i;
            const end = Math.min(i + windowSize, content.length)
            const window = content.slice(start,end)
            console.log("window", window);
            promises.push(embedder(window).then((v) => {
              vecs.push([v, start , end])
          }));
            i += (windowSize / 4) * 3;
          }
          await Promise.all(promises);
        }

        const { record_id } = db
          .query(
            "INSERT INTO records (created_at, url, title, content) VALUES (?, ?, ?, ?) RETURNING record_id",
          )
          .get(new Date().toISOString(), url, title, content);

        const bindings = vecs.flatMap(([v, start, end]) => [
          record_id,
          start,end,
          JSON.stringify(v.tolist()[0][0]),
        ]);
        const sql = `INSERT INTO vecs(record_id, start, end, embedding) VALUES ${new Array(vecs.length).fill("(?, ?, ?, ?)").join(", ")}`;
        db.run(sql, ...bindings);
      });

      await result();

      return new Response("lol", {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    },
  },
});

console.log(`Server started on http://localhost:${result.port}`);
