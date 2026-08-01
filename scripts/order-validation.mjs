import { createPublicClient } from "viem";
import { polygonAmoy } from "viem/chains";
import { amoyTransport } from "./matcher-core.mjs";
import {
  readCurrentExchangeArtifact,
  toContractOrder,
} from "./order-utils.mjs";

function compactError(error) {
  const message =
    error && typeof error === "object" && typeof error.shortMessage === "string"
      ? error.shortMessage
      : error instanceof Error
        ? error.message
        : String(error);
  return message.replace(/\s+/g, " ").trim();
}

export async function validateSignedOrder(
  deployment,
  row,
  {
    client = createPublicClient({
      chain: polygonAmoy,
      transport: amoyTransport(),
    }),
    artifact = readCurrentExchangeArtifact(deployment),
  } = {},
) {
  try {
    await client.readContract({
      address: deployment.exchange,
      abi: artifact.abi,
      functionName: "validateOrder",
      args: [toContractOrder(row)],
    });
    return {
      status: "VALID",
      error: null,
      validatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const message = compactError(error);
    throw Object.assign(
      new Error(`Exchange validateOrder rejected the order: ${message}`),
      {
        statusCode: 422,
        validationError: message,
      },
    );
  }
}
