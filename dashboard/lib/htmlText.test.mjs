import test from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "./htmlText.ts";

test("an HTML-only reply keeps its words and line breaks", () => {
  // Shape of a real Outlook-style HTML-only reply (2026-09-16).
  const html = `<html><head><style>p{margin:0}</style><title>x</title></head><body>
    <div>Hola,</div><div>¿Cuál es el botón para aceptar el pedido?<br>Gracias</div>
    <p>Saludos&nbsp;&amp; flores</p>
    <blockquote><div>El 16 sept 2026, Facundo escribió:</div></blockquote></body></html>`;
  const text = htmlToText(html);
  assert.ok(text.startsWith("Hola,"), text);
  assert.ok(text.includes("¿Cuál es el botón para aceptar el pedido?\nGracias"), text);
  assert.ok(text.includes("Saludos & flores"), text);
  assert.ok(!text.includes("<") && !text.includes("margin"), text);
});

test("decodes numeric and French entities", () => {
  assert.equal(htmlToText("<p>&laquo;Oui, je confirme&raquo; &#233;t&#xE9;</p>"), "«Oui, je confirme» été");
});

test("empty or missing HTML yields an empty string", () => {
  assert.equal(htmlToText(""), "");
  assert.equal(htmlToText(null), "");
  assert.equal(htmlToText(undefined), "");
});

test("does not leave runs of blank lines", () => {
  assert.equal(htmlToText("<div>a</div><div></div><div></div><div>b</div>"), "a\n\nb");
});
