import Database from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { pipeline } from "@xenova/transformers";
import { getLoadablePath } from "sqlite-vec";

// Minimal shape for the embedding tensor returned by the pipeline.
type EmbeddingTensor = {
  tolist: () => number[][][];
};

// Encapsulate all DB and embedding logic in this module.
export class Storage {
  db: Database;
  embedder: (input: string) => Promise<EmbeddingTensor>;

  private constructor(db: Database, embedder: (input: string) => Promise<EmbeddingTensor>) {
    this.db = db;
    this.embedder = embedder;
  }

  static async create(): Promise<Storage> {
    const embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

    // Try to set a custom sqlite path on systems that need it (macOS/Homebrew).
    try {
      Database.setCustomSQLite("/opt/homebrew/Cellar/sqlite/3.50.4/lib/libsqlite3.dylib");
    } catch (e) {
      console.warn("setCustomSQLite failed:", e);
    }

    const db = new Database("dev.db", { create: true });
    db.loadExtension(getLoadablePath());

    const vecInfo = db.prepare("select vec_version() as vec_version;").get() as { vec_version: string } | undefined;
    if (vecInfo) console.log(`vec_version=${vecInfo.vec_version}`);

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

    return new Storage(db, embedder as unknown as (input: string) => Promise<EmbeddingTensor>);
  }

  async search(query: string) {
  const embedding = await this.embedder(query);
  const arr = embedding.tolist();
  const first = arr?.[0]?.[0] ?? [];
  const bindings = JSON.stringify(first);
    const result = this.db
      .query(
        `
select Q.record_id, start, end, url, title, created_at,
       substr(content, start, end - start) as snippet,
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

  async store(data: { content: string; title: string; url: string }) {
    const { content, title, url } = data;

    const vecs: [EmbeddingTensor, number, number][] = [];
    const windowSize = 1024;
    let i = 0;
    const promises: Promise<void>[] = [];
    while (i < content.length) {
      const start = i;
      const end = Math.min(i + windowSize, content.length);
      const window = content.slice(start, end);
      promises.push(
        this.embedder(window).then((v) => {
          vecs.push([v, start, end]);
        }),
      );
      i += (windowSize / 4) * 3;
    }
    await Promise.all(promises);

    const insert = this.db
      .query("INSERT INTO records (created_at, url, title, content) VALUES (?, ?, ?, ?) RETURNING record_id")
      .get(new Date().toISOString(), url, title, content) as { record_id: number } | undefined;

    if (!insert) return;

    const record_id = insert.record_id;

    if (vecs.length === 0) return;

    const bindings: (string | number)[] = vecs.flatMap(([v, start, end]) => {
      const arr = v.tolist();
      const first = arr?.[0]?.[0] ?? [];
      return [record_id, start, end, JSON.stringify(first)];
    });
    const sql = `INSERT INTO vecs(record_id, start, end, embedding) VALUES ${new Array(vecs.length).fill("(?, ?, ?, ?)").join(", ")}`;
    // Bun's sqlite binding accepts a variadic list of bindings; cast to unknown[] to satisfy TS.
  const normalized = bindings.map((b) => (b === null || b === undefined ? "" : b)) as SQLQueryBindings[];
  this.db.run(sql, normalized);
  }
}

export default Storage;
