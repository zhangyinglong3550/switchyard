import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function readPackageJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"));
}

test("desktop workspace declares the checked-in core workspace version", () => {
  const core = readPackageJson("packages/core/package.json");
  const desktop = readPackageJson("apps/desktop/package.json");

  assert.equal(desktop.dependencies[core.name], core.version);
});
