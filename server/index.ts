import type { BunRequest } from "bun";
import { intlFormatDistance } from "date-fns";
import Storage from "./storage";

interface Record {
  record_id: number;
  url: string;
  start: number;
  end: number;
  title: string;
  created_at: string;
  distance: number;
  snippet?: string;
}

const storage = await Storage.create();

const result = Bun.serve({
  port: 1729,

  routes: {
    "/": async (req: BunRequest) => {
      let results: Record[] = [];
      let query: string = "";
      if (req.method === "POST") {
        const params = new URLSearchParams(await req.text());
        const maybeQuery = params.get("query");
        if (!maybeQuery) return Response.error();
        query = maybeQuery;
        results = (await storage.search(query)) as Record[];
      }

      const today = new Date();
      return new Response(
        `
      <meta charset="utf-8" /> <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body { padding: 1rem; }
        .container form { margin: auto; max-width: 968px; display: flex; flex-direction: column; gap: 1rem; }
        ul { display: flex; flex-direction: column; list-style-type: none; padding: 0; gap: 1rem; }
        ul.list li { border: 1px solid gray; padding: 1rem; }
        ul.list li h3 { margin: 0; }
      </style>
      <div class=container> <form method=POST>
        <input type=text name=query placeholder="Search..." value="${query}" />
        ${
          results &&
          `<ul class=list>${results.map(
            (result) =>
              `<li><a href="${result.url}" target=_blank rel=noopener><h3>${result.title}</h3><small>${intlFormatDistance(new Date(result.created_at), today)} - ${result.url}</small></a><p>${result.snippet}</p>`,
          )}</ul>`
        }
      </form> </div>
    `,
        { headers: { "Content-Type": "text/html" } },
      );
    },

    "/api/search": async (req: BunRequest): Promise<Response> => {
      const url = new URL(req.url);
      const query = url.searchParams.get("query");
      if (!query) return Response.error();
      const res = await storage.search(query);
      return Response.json(res);
    },

    "/api/store": async (req: BunRequest): Promise<Response> => {
      if (req.method === "OPTIONS") {
        return new Response("", {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
          },
        });
      }

      const data = await req.text();
      const parsed = JSON.parse(data);
      await storage.store(parsed);

      return new Response("ok", {
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
