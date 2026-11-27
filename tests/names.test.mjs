// Every upper-case constant a mod file uses is declared or imported in that file: one used but never imported only
// throws when its code runs (a menu that never opens), so `--check` alone does not catch it.

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";

const GLOBALS = new Set(["JSON", "URL", "NaN", "UTC", "ID"]);

/**
 * The code with comments, strings, regular expressions and the text of template literals blanked out (a template's
 * `${…}` stays code), so only names in code are left.
 */
function codeOf(text) {
  let out = "";
  let i = 0;
  const depth = []; // For each open `${`, how many `{` deep it is.
  const regexCan = () => /(^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase)\s*$/.test(out.slice(-40));
  const template = () => {
    // From just after a backtick: skips its text, entering code at `${`.
    while (i < text.length) {
      if (text[i] === "\\") i += 2;
      else if (text[i] === "`") return void (i++, (out += '""'));
      else if (text[i] === "$" && text[i + 1] === "{") return void ((i += 2), (out += '"" + ('), depth.push(0));
      else i++;
    }
  };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i = text.indexOf("*/", i + 2);
      i = i < 0 ? text.length : i + 2;
      out += " ";
    } else if (c === '"' || c === "'") {
      i++;
      while (i < text.length && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
    } else if (c === "`") {
      i++;
      template();
    } else if (c === "/" && regexCan()) {
      i++;
      let klass = false;
      while (i < text.length && text[i] !== "\n" && (klass || text[i] !== "/")) {
        if (text[i] === "\\") i++;
        else if (text[i] === "[") klass = true;
        else if (text[i] === "]") klass = false;
        i++;
      }
      i++;
      while (/[a-z]/.test(text[i] ?? "")) i++;
      out += '""';
    } else if (c === "{" && depth.length) {
      depth[depth.length - 1]++;
      out += c;
      i++;
    } else if (c === "}" && depth.length && depth.at(-1) === 0) {
      depth.pop();
      out += ") + ";
      i++;
      template();
    } else {
      if (c === "}" && depth.length) depth[depth.length - 1]--;
      out += c;
      i++;
    }
  }
  // A re-export names what another file declares.
  return out.replace(/\bexport\s*\{[^}]*\}\s*from\s*""/g, " ");
}

/** The names a file declares or imports. */
function declared(code) {
  const names = new Set();
  for (const m of code.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=/g))
    for (const part of m[1].split(",")) names.add(part.trim().split(/\s*[:=]\s*/).at(part.includes(":") ? 1 : 0).replace(/^\.\.\./, ""));
  for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}/g))
    for (const part of m[1].split(",")) names.add(part.trim().split(/\s+as\s+/).at(-1));
  for (const m of code.matchAll(/\bimport\s+\*\s+as\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of code.matchAll(/\bimport\s+([\w$]+)\s*[,\s]/g)) names.add(m[1]);
  return names;
}

test("every upper-case constant a mod file uses is declared or imported there", async () => {
  const folder = new URL("../mods/flow/", import.meta.url);
  const missing = [];
  for (const name of await readdir(folder)) {
    if (!name.endsWith(".js")) continue;
    // A spread (`...KINDS`) reads the name as a value, not as a property.
    const code = codeOf(await readFile(new URL(name, folder), "utf8")).replace(/\.\.\./g, " ");
    const have = declared(code);
    // An upper-case name read as a value: not a property (`.X`), not an object key (`X:`) or a method's name.
    for (const m of code.matchAll(/(?<![.\w$])([A-Z][A-Z0-9_]+)\b(?!\s*:(?!:))/g)) {
      if (!have.has(m[1]) && !GLOBALS.has(m[1])) missing.push(`${name}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
