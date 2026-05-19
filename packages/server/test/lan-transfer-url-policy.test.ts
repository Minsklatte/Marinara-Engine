import test from "node:test";
import assert from "node:assert/strict";
import {
  isAllowedLanTransferAddress,
  validateLanTransferOrigin,
} from "../src/services/lan-transfer/lan-transfer-url-policy.js";

test("allows loopback and RFC1918 addresses", () => {
  assert.equal(isAllowedLanTransferAddress("127.0.0.1"), true);
  assert.equal(isAllowedLanTransferAddress("192.168.1.10"), true);
  assert.equal(isAllowedLanTransferAddress("10.0.0.5"), true);
  assert.equal(isAllowedLanTransferAddress("172.16.0.5"), true);
  assert.equal(isAllowedLanTransferAddress("172.31.255.254"), true);
});

test("blocks public and metadata/link-local addresses", () => {
  assert.equal(isAllowedLanTransferAddress("8.8.8.8"), false);
  assert.equal(isAllowedLanTransferAddress("1.1.1.1"), false);
  assert.equal(isAllowedLanTransferAddress("169.254.169.254"), false);
});

test("validates origin shape", async () => {
  const valid = await validateLanTransferOrigin("http://192.168.1.10:7860", {
    resolveHost: async () => ["192.168.1.10"],
  });
  assert.equal(valid.ok, true);

  const withPath = await validateLanTransferOrigin("http://192.168.1.10:7860/path", {
    resolveHost: async () => ["192.168.1.10"],
  });
  assert.equal(withPath.ok, false);

  const publicHost = await validateLanTransferOrigin("http://example.com", {
    resolveHost: async () => ["93.184.216.34"],
  });
  assert.equal(publicHost.ok, false);
});
