import { Readability } from "@mozilla/readability";

const url = document.location.href;
const urlParsed = new URL(url);
const title = document.title;
// TODO: Normalize the URL

const doc2 = document.cloneNode(true);
const reader = new Readability(doc2);
const article = reader.parse();
const content = article?.textContent;

const payload = { url, title, content };
// console.log("payload", JSON.stringify(payload));

async function main() {
  window.addEventListener("load", async () => {
    // Your code here will execute after the entire page and all resources are loaded
    console.log("Page and all resources are fully loaded!");
    await fetch("http://localhost:1729/api/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  });
}

if (!urlParsed.hostname.startsWith("localhost")) {
  main();
}
