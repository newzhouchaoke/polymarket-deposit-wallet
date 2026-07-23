import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { artifactPath } from "../src/artifact.js";
import { PROJECT_DIR } from "../src/env.js";

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

const artifactContractNames = [
  "ResearchMockUSD",
  "ResearchWalletCoin",
  "ResearchOutcomeToken",
  "ResearchMarketRegistry",
  "ResearchDepositWallet",
  "ResearchDepositWalletFactory",
  "ResearchCLOBExchange",
];
const sourceFileNames = fs
  .readdirSync(path.resolve(PROJECT_DIR, "contracts"))
  .filter((fileName) => fileName.endsWith(".sol"));
const sources = Object.fromEntries(
  sourceFileNames.map((fileName) => {
    return [
      fileName,
      {
        content: fs.readFileSync(
          path.resolve(PROJECT_DIR, "contracts", fileName),
          "utf8",
        ),
      },
    ];
  }),
);
const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    outputSelection: {
      "*": { "*": ["abi", "evm.bytecode.object"] },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors ?? []) as Array<{
  severity: string;
  formattedMessage: string;
}>;
for (const error of errors) {
  const logger = error.severity === "error" ? console.error : console.warn;
  logger(error.formattedMessage);
}
if (errors.some((error) => error.severity === "error")) {
  process.exitCode = 1;
} else {
  for (const contractName of artifactContractNames) {
    const file = artifactPath(contractName);
    let contract;
    for (const contracts of Object.values(output.contracts) as Array<
      Record<string, { abi: unknown; evm: { bytecode: { object: string } } }>
    >) {
      if (contracts[contractName]) {
        contract = contracts[contractName];
        break;
      }
    }
    if (!contract) throw new Error(`未找到合约输出：${contractName}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          contractName,
          abi: contract.abi,
          bytecode: `0x${contract.evm.bytecode.object}`,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`合约编译成功：${file}`);
  }
}
