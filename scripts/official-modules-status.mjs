import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatEther, getAddress } from "viem";
import { polygonAmoy } from "viem/chains";
import { amoyTransport } from "./matcher-core.mjs";
import { projectDir } from "./db.js";

const STANDARD_REFERENCE = "0xE111180000d2663C0091e4f400237545B87B996B";
const NEG_RISK_REFERENCE = "0xe2222d279d744050d28e00520010520000310F59";
const UMA_FINDER = "0x28077B47Cd03326De7838926A63699849DD4fa87";
const UMA_OPTIMISTIC_ORACLE_V2 =
  "0x38fAc33bD20D4c4Cce085C0f347153C06CbA2968";
const getterAbi = [
  "getCollateral",
  "getCtf",
  "getCtfCollateral",
  "getOutcomeTokenFactory",
  "getProxyFactory",
  "getSafeFactory",
].map((name) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs: [],
  outputs: [{ type: "address" }],
}));

function readJsonIfPresent(filePath) {
  return fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf8"))
    : null;
}

function artifactBuilt(relativePath) {
  const filePath = path.join(projectDir, relativePath);
  if (!fs.existsSync(filePath)) return { built: false, path: filePath };
  const artifact = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const bytecode =
    artifact.bytecode?.object ?? artifact.bytecode ?? artifact.evm?.bytecode?.object;
  return {
    built: typeof bytecode === "string" && bytecode !== "" && bytecode !== "0x",
    path: filePath,
  };
}

async function referenceStatus(publicClient, name, address) {
  const code = await publicClient.getCode({ address });
  const dependencyValues = await Promise.all(
    getterAbi.map((item) =>
      publicClient.readContract({
        address,
        abi: getterAbi,
        functionName: item.name,
      }),
    ),
  );
  const dependencies = Object.fromEntries(
    getterAbi.map((item, index) => [
      `${item.name[3].toLowerCase()}${item.name.slice(4)}`,
      getAddress(dependencyValues[index]),
    ]),
  );
  return {
    name,
    address: getAddress(address),
    hasCode: Boolean(code && code !== "0x"),
    dependencies,
  };
}

export async function officialModulesStatus() {
  const publicClient = createPublicClient({
    chain: polygonAmoy,
    transport: amoyTransport(),
  });
  const chainId = await publicClient.getChainId();
  if (chainId !== 80002) throw new Error(`只支持 Polygon Amoy，当前 ${chainId}`);
  const v2Deployment = readJsonIfPresent(
    path.join(projectDir, "deployments", "official-v2-amoy.json"),
  );
  const umaDeployment = readJsonIfPresent(
    path.join(projectDir, "deployments", "official-uma-amoy.json"),
  );
  const [standardReference, negRiskReference, finderCode, oracleCode] =
    await Promise.all([
      referenceStatus(publicClient, "standard", STANDARD_REFERENCE),
      referenceStatus(publicClient, "negRisk", NEG_RISK_REFERENCE),
      publicClient.getCode({ address: UMA_FINDER }),
      publicClient.getCode({ address: UMA_OPTIMISTIC_ORACLE_V2 }),
    ]);
  const localStandard = v2Deployment?.contracts?.standard?.address ?? null;
  const localNegRisk = v2Deployment?.contracts?.negRisk?.address ?? null;
  const localUma = umaDeployment?.address ?? null;
  const [standardCode, negRiskCode, umaCode] = await Promise.all([
    localStandard
      ? publicClient.getCode({ address: localStandard })
      : Promise.resolve(null),
    localNegRisk
      ? publicClient.getCode({ address: localNegRisk })
      : Promise.resolve(null),
    localUma
      ? publicClient.getCode({ address: localUma })
      : Promise.resolve(null),
  ]);
  const deployer = v2Deployment?.deployer ?? null;
  const deployerBalance = deployer
    ? await publicClient.getBalance({ address: deployer })
    : null;

  return {
    chainId,
    checkedAt: new Date().toISOString(),
    deployer,
    deployerBalancePOL:
      deployerBalance === null ? null : formatEther(deployerBalance),
    standard: {
      source: artifactBuilt(
        "official/ctf-exchange-v2/out/CTFExchange.sol/CTFExchange.json",
      ),
      officialReference: standardReference,
      localDeployment: localStandard,
      localHasCode: Boolean(standardCode && standardCode !== "0x"),
      runtimeReady: Boolean(localStandard && standardCode && standardCode !== "0x"),
    },
    negRisk: {
      source: artifactBuilt(
        "official/neg-risk-ctf-adapter/out/NegRiskAdapter.sol/NegRiskAdapter.json",
      ),
      exchangeSource: artifactBuilt(
        "official/ctf-exchange-v2/out/CTFExchange.sol/CTFExchange.json",
      ),
      officialReference: negRiskReference,
      localExchangeDeployment: localNegRisk,
      localHasCode: Boolean(negRiskCode && negRiskCode !== "0x"),
      runtimeReady: Boolean(localNegRisk && negRiskCode && negRiskCode !== "0x"),
      nextAction:
        localNegRisk && negRiskCode && negRiskCode !== "0x"
          ? "配置 OFFICIAL_V2_RUNTIME_VARIANT=neg-risk 和对应市场"
          : "余额充足后运行 OFFICIAL_V2_VARIANT=neg-risk npm run official:deploy:amoy",
    },
    uma: {
      source: artifactBuilt(
        "official/uma-ctf-adapter/out/UmaCtfAdapter.sol/UmaCtfAdapter.json",
      ),
      finder: {
        address: UMA_FINDER,
        hasCode: Boolean(finderCode && finderCode !== "0x"),
      },
      optimisticOracleV2: {
        address: UMA_OPTIMISTIC_ORACLE_V2,
        hasCode: Boolean(oracleCode && oracleCode !== "0x"),
      },
      localDeployment: localUma,
      localHasCode: Boolean(umaCode && umaCode !== "0x"),
      runtimeReady: Boolean(localUma && umaCode && umaCode !== "0x"),
      nextAction:
        localUma && umaCode && umaCode !== "0x"
          ? "配置市场 oracle 为 UMA Adapter 并按 request/resolve 生命周期调用"
          : "余额充足后运行 npm run official:uma:deploy:amoy",
    },
    writesPerformed: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  console.log(JSON.stringify(await officialModulesStatus(), null, 2));
}
