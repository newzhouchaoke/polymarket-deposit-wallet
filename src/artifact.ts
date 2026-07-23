import fs from "node:fs";
import path from "node:path";
import type { Abi, Hex } from "viem";
import { PROJECT_DIR } from "./env.js";

export interface ContractArtifact {
  contractName: string;
  abi: Abi;
  bytecode: Hex;
}

export function artifactPath(contractName: string): string {
  return path.resolve(PROJECT_DIR, "artifacts", `${contractName}.json`);
}

export function readArtifact(contractName: string): ContractArtifact {
  const file = artifactPath(contractName);
  if (!fs.existsSync(file)) {
    throw new Error("缺少合约 artifact，请先运行 npm run build");
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as ContractArtifact;
}
