import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { decodeRequestBody } from "../src/utils.mjs";

test("decodeRequestBody decodes compressed JSON request bodies", () => {
  const json = Buffer.from(JSON.stringify({ model: "missing-test-model", input: "hi" }));

  assert.deepEqual(JSON.parse(decodeRequestBody(json, "identity").toString("utf8")), { model: "missing-test-model", input: "hi" });
  assert.deepEqual(JSON.parse(decodeRequestBody(zlib.gzipSync(json), "gzip").toString("utf8")), { model: "missing-test-model", input: "hi" });
  assert.deepEqual(JSON.parse(decodeRequestBody(zlib.brotliCompressSync(json), "br").toString("utf8")), { model: "missing-test-model", input: "hi" });
  assert.deepEqual(JSON.parse(decodeRequestBody(zlib.deflateSync(json), "deflate").toString("utf8")), { model: "missing-test-model", input: "hi" });

  if (typeof zlib.zstdCompressSync === "function") {
    assert.deepEqual(JSON.parse(decodeRequestBody(zlib.zstdCompressSync(json), "zstd").toString("utf8")), { model: "missing-test-model", input: "hi" });
  }
});
