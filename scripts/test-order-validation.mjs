import assert from "node:assert/strict";
import { validateSignedOrder } from "./order-validation.mjs";

const deployment = {
  exchange: "0x0000000000000000000000000000000000000001",
};
const row = {
  salt: "1",
  maker: "0x0000000000000000000000000000000000000002",
  signer: "0x0000000000000000000000000000000000000002",
  token_id: "3",
  maker_amount: "500000",
  taker_amount: "1000000",
  side: "BUY",
  signature: `0x${"11".repeat(65)}`,
  raw_json: JSON.stringify({
    signatureType: 0,
    timestamp: "1",
    metadata: `0x${"00".repeat(32)}`,
    builder: `0x${"00".repeat(32)}`,
  }),
};
let captured;
const successClient = {
  async readContract(request) {
    captured = request;
  },
};
const valid = await validateSignedOrder(deployment, row, {
  client: successClient,
  artifact: { abi: [] },
});
assert.equal(valid.status, "VALID");
assert.equal(captured.functionName, "validateOrder");
assert.equal(captured.args[0].signature, row.signature);

await assert.rejects(
  validateSignedOrder(deployment, row, {
    client: {
      async readContract() {
        throw Object.assign(new Error("execution reverted"), {
          shortMessage: "signature verification failed",
        });
      },
    },
    artifact: { abi: [] },
  }),
  (error) =>
    error.statusCode === 422 &&
    /signature verification failed/.test(error.message),
);

console.log("signed order admission validation tests passed");
